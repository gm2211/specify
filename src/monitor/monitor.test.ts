import assert from 'node:assert/strict';
import test from 'node:test';

import {
  and,
  eventually,
  formulaSchema,
  globally,
  implies,
  isFormula,
  next,
  not,
  or,
  pred,
  render,
  until,
  validateFormula,
  type Formula,
} from './formula.js';
import { evaluate, type EvaluateOptions, type Verdict } from './evaluate.js';
import {
  buildEventTimeline,
  buildStepTrace,
  predicateEvaluator,
  type PredicateEvaluator,
  type PredicateVerdict,
  type Trace,
  type TraceEvent,
} from './trace.js';

// --- Test harness -------------------------------------------------------------
//
// A trace is described as a list of rows; each row maps atom name -> verdict.
// The evaluator reads the current position's row (stored as `step`).

type Row = Record<string, PredicateVerdict>;

function buildTrace(rows: Row[]): Trace {
  return rows.map((step, index) => ({ index, events: [], step }));
}

const tableEval: PredicateEvaluator = predicateEvaluator((p, state) => {
  const table = state.step as Row | undefined;
  if (!table || !(p.name in table)) return 'unevaluable';
  return table[p.name];
});

function verdict(f: Formula, rows: Row[], options: EvaluateOptions = {}): Verdict {
  return evaluate(f, buildTrace(rows), tableEval, options).verdict;
}

const complete: EvaluateOptions = { traceComplete: true };
const prefix: EvaluateOptions = { traceComplete: false };

const P = pred('p');
const Q = pred('q');

// --- Pretty-printer -----------------------------------------------------------

test('render: matches the documented example exactly', () => {
  const f = globally(
    implies(pred('click', ['#login']), eventually(pred('resp', ['/api/session', '200']))),
  );
  assert.equal(render(f), 'G(pred:click(#login) -> F(pred:resp(/api/session, 200)))');
});

test('render: unambiguous forms are stable', () => {
  assert.equal(render(pred('p')), 'pred:p');
  assert.equal(render(not(pred('p'))), '!(pred:p)');
  assert.equal(render(and(pred('a'), pred('b'), pred('c'))), '(pred:a & pred:b & pred:c)');
  assert.equal(render(or(pred('a'), pred('b'))), '(pred:a | pred:b)');
  assert.equal(render(next(pred('p'))), 'X(pred:p)');
  assert.equal(render(eventually(pred('p'))), 'F(pred:p)');
  assert.equal(render(until(pred('p'), pred('q'))), '(pred:p U pred:q)');
  // Nested compound argument reuses its own brackets under a unary op.
  assert.equal(render(globally(and(pred('a'), pred('b')))), 'G(pred:a & pred:b)');
  assert.equal(render(not(until(pred('p'), pred('q')))), '!(pred:p U pred:q)');
});

// --- Schema -------------------------------------------------------------------

test('schema: accepts well-formed ASTs', () => {
  const good: Formula[] = [
    pred('p'),
    pred('p', ['x', 'y']),
    not(pred('p')),
    and(pred('a'), pred('b')),
    or(pred('a'), pred('b')),
    implies(pred('a'), pred('b')),
    next(pred('p')),
    eventually(pred('p')),
    globally(pred('p')),
    until(pred('p'), pred('q')),
    globally(implies(pred('click'), eventually(pred('resp')))),
  ];
  for (const f of good) {
    const res = validateFormula(f);
    assert.equal(res.valid, true, `${render(f)} should be valid: ${res.errors.join('; ')}`);
    assert.equal(isFormula(f), true);
  }
});

test('schema: rejects malformed ASTs', () => {
  const bad: unknown[] = [
    {},
    { op: 'pred' }, // missing name
    { op: 'pred', name: '' }, // empty name
    { op: 'pred', name: 'p', extra: 1 }, // additional property
    { op: 'nope', arg: pred('p') }, // unknown op
    { op: 'and', args: [] }, // empty conjunction
    { op: 'and' }, // missing args
    { op: 'not' }, // missing arg
    { op: 'implies', left: pred('a') }, // missing right
    { op: 'X', arg: { op: 'pred' } }, // bad nested pred
    { op: 'U', left: pred('a') }, // missing right
    'pred:p',
    null,
  ];
  for (const value of bad) {
    assert.equal(validateFormula(value).valid, false, `${JSON.stringify(value)} should be invalid`);
  }
});

// --- Per-operator unit cases --------------------------------------------------

test('pred: holds / fails / unevaluable at a single position', () => {
  assert.equal(verdict(P, [{ p: true }]), 'satisfied');
  assert.equal(verdict(P, [{ p: false }]), 'violated');
  assert.equal(verdict(P, [{}]), 'unevaluable'); // atom absent from table
});

test('not: flips satisfied and violated', () => {
  assert.equal(verdict(not(P), [{ p: true }]), 'violated');
  assert.equal(verdict(not(P), [{ p: false }]), 'satisfied');
});

test('and / or: n-ary boolean at a position', () => {
  assert.equal(verdict(and(P, Q), [{ p: true, q: true }]), 'satisfied');
  assert.equal(verdict(and(P, Q), [{ p: true, q: false }]), 'violated');
  assert.equal(verdict(or(P, Q), [{ p: false, q: true }]), 'satisfied');
  assert.equal(verdict(or(P, Q), [{ p: false, q: false }]), 'violated');
});

test('implies: material implication', () => {
  assert.equal(verdict(implies(P, Q), [{ p: true, q: false }]), 'violated');
  assert.equal(verdict(implies(P, Q), [{ p: false, q: false }]), 'satisfied'); // vacuous
  assert.equal(verdict(implies(P, Q), [{ p: true, q: true }]), 'satisfied');
});

test('X: strong next reaches the following position', () => {
  assert.equal(verdict(next(P), [{}, { p: true }]), 'satisfied');
  assert.equal(verdict(next(P), [{}, { p: false }]), 'violated');
});

test('X at the last position = false (strong next), complete mode', () => {
  assert.equal(verdict(next(P), [{ p: true }], complete), 'violated');
});

test('X at the last observed position = inconclusive in prefix mode', () => {
  assert.equal(verdict(next(P), [{ p: true }], prefix), 'inconclusive');
});

test('F: eventually witnessed = satisfied (both modes), earliest witness', () => {
  const rows: Row[] = [{ p: false }, { p: false }, { p: true }];
  assert.equal(verdict(eventually(P), rows, complete), 'satisfied');
  assert.equal(verdict(eventually(P), rows, prefix), 'satisfied');
  const res = evaluate(eventually(P), buildTrace(rows), tableEval);
  assert.equal(res.witnessStep, 2);
});

test('F: never witnessed = violated (complete) vs inconclusive (prefix)', () => {
  const rows: Row[] = [{ p: false }, { p: false }];
  assert.equal(verdict(eventually(P), rows, complete), 'violated');
  assert.equal(verdict(eventually(P), rows, prefix), 'inconclusive');
});

test('G: holds throughout = satisfied (complete) vs inconclusive (prefix)', () => {
  const rows: Row[] = [{ p: true }, { p: true }];
  assert.equal(verdict(globally(P), rows, complete), 'satisfied');
  assert.equal(verdict(globally(P), rows, prefix), 'inconclusive');
});

test('G: a single false position = violated (both modes), first violating witness', () => {
  const rows: Row[] = [{ p: true }, { p: false }, { p: true }];
  assert.equal(verdict(globally(P), rows, complete), 'violated');
  assert.equal(verdict(globally(P), rows, prefix), 'violated');
  const res = evaluate(globally(P), buildTrace(rows), tableEval, prefix);
  assert.equal(res.witnessStep, 1);
});

test('U: satisfied when right occurs with left holding until then', () => {
  const rows: Row[] = [
    { p: true, q: false },
    { p: true, q: true },
  ];
  assert.equal(verdict(until(P, Q), rows, complete), 'satisfied');
  assert.equal(verdict(until(P, Q), rows, prefix), 'satisfied');
});

test('U: left fails before right = violated (both modes)', () => {
  const rows: Row[] = [
    { p: true, q: false },
    { p: false, q: false },
  ];
  assert.equal(verdict(until(P, Q), rows, complete), 'violated');
  assert.equal(verdict(until(P, Q), rows, prefix), 'violated');
});

test('U: right never occurs but left holds = violated (complete) vs inconclusive (prefix)', () => {
  const rows: Row[] = [
    { p: true, q: false },
    { p: true, q: false },
  ];
  assert.equal(verdict(until(P, Q), rows, complete), 'violated');
  assert.equal(verdict(until(P, Q), rows, prefix), 'inconclusive');
});

// --- Empty-trace conventions --------------------------------------------------

test('empty trace: complete-mode conventions (G=satisfied, F=violated, pred=violated)', () => {
  assert.equal(verdict(globally(P), [], complete), 'satisfied');
  assert.equal(verdict(eventually(P), [], complete), 'violated');
  assert.equal(verdict(P, [], complete), 'violated');
});

test('empty trace: prefix-mode conventions (all inconclusive)', () => {
  assert.equal(verdict(globally(P), [], prefix), 'inconclusive');
  assert.equal(verdict(eventually(P), [], prefix), 'inconclusive');
  assert.equal(verdict(P, [], prefix), 'inconclusive');
});

// --- Unevaluable propagation --------------------------------------------------

test('unevaluable matters: F over unevaluable-then-false = unevaluable (complete)', () => {
  const rows: Row[] = [{ p: 'unevaluable' }, { p: false }];
  assert.equal(verdict(eventually(P), rows, complete), 'unevaluable');
});

test('unevaluable is masked: a later definite witness determines the verdict', () => {
  const rows: Row[] = [{ p: 'unevaluable' }, { p: true }];
  assert.equal(verdict(eventually(P), rows, complete), 'satisfied');
});

test('unevaluable matters: G with one unevaluable position (rest true) = unevaluable', () => {
  const rows: Row[] = [{ p: true }, { p: 'unevaluable' }, { p: true }];
  assert.equal(verdict(globally(P), rows, complete), 'unevaluable');
});

test('unevaluable is masked: a definite G violation wins over an earlier unevaluable', () => {
  const rows: Row[] = [{ p: true }, { p: 'unevaluable' }, { p: false }];
  const res = evaluate(globally(P), buildTrace(rows), tableEval, complete);
  assert.equal(res.verdict, 'violated');
  assert.equal(res.witnessStep, 2);
});

test('unevaluable is masked in and/or by a definite result', () => {
  // and: any definite violated wins over unevaluable.
  assert.equal(verdict(and(P, Q), [{ p: false, q: 'unevaluable' }]), 'violated');
  // or: any definite satisfied wins over unevaluable.
  assert.equal(verdict(or(P, Q), [{ p: true, q: 'unevaluable' }]), 'satisfied');
  // no definite result -> unevaluable surfaces.
  assert.equal(verdict(and(P, Q), [{ p: true, q: 'unevaluable' }]), 'unevaluable');
});

// --- Witness detail callback --------------------------------------------------

test('witnessDetail is produced via the callback for the decisive position', () => {
  const rows: Row[] = [{ p: true }, { p: false }];
  const res = evaluate(globally(P), buildTrace(rows), tableEval, {
    traceComplete: true,
    describeWitness: ({ verdict: v, position }) => `${v} at step ${position}`,
  });
  assert.equal(res.verdict, 'violated');
  assert.equal(res.witnessStep, 1);
  assert.equal(res.witnessDetail, 'violated at step 1');
});

// --- Trace builders (two-sorted / event-timeline) -----------------------------

test('buildStepTrace: buckets events into the window ending at each step', () => {
  const steps = [
    { ts: 10, step: 's0' },
    { ts: 20, step: 's1' },
    { ts: 30, step: 's2' },
  ];
  const events: TraceEvent[] = [
    { ts: 5, kind: 'a' }, // <= first step -> position 0
    { ts: 15, kind: 'b' }, // (10, 20] -> position 1
    { ts: 20, kind: 'c' }, // boundary, inclusive upper -> position 1
    { ts: 25, kind: 'd' }, // (20, 30] -> position 2
    { ts: 99, kind: 'e' }, // after last step -> attached to last position
  ];
  const trace = buildStepTrace(steps, events);
  assert.deepEqual(
    trace.map((s) => s.events.map((e) => e.kind)),
    [['a'], ['b', 'c'], ['d', 'e']],
  );
  assert.equal(trace[0].step, 's0');
});

test('buildEventTimeline: one position per event, timestamp-ordered', () => {
  const events: TraceEvent[] = [
    { ts: 30, kind: 'c' },
    { ts: 10, kind: 'a' },
    { ts: 20, kind: 'b' },
  ];
  const trace = buildEventTimeline(events);
  assert.deepEqual(
    trace.map((s) => s.events[0].kind),
    ['a', 'b', 'c'],
  );
  assert.equal(
    trace.every((s) => s.step === undefined),
    true,
  );
});

// --- Performance --------------------------------------------------------------

test('evaluates a 1000-position trace in well under 100ms', () => {
  const rows: Row[] = Array.from({ length: 1000 }, () => ({ a: true, b: true }));
  // G(a -> F b): a non-trivial nested temporal formula.
  const f = globally(implies(pred('a'), eventually(pred('b'))));
  const trace = buildTrace(rows);
  const start = performance.now();
  const res = evaluate(f, trace, tableEval, complete);
  const elapsed = performance.now() - start;
  assert.equal(res.verdict, 'satisfied');
  assert.ok(elapsed < 100, `evaluation took ${elapsed.toFixed(2)}ms, expected < 100ms`);
});

// --- Property-style tests (seeded random) -------------------------------------

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = ['a', 'b', 'c'];

function randomFormula(rng: () => number, depth: number): Formula {
  if (depth <= 0 || rng() < 0.4) {
    return pred(ATOMS[Math.floor(rng() * ATOMS.length)]);
  }
  const choice = Math.floor(rng() * 8);
  const sub = (): Formula => randomFormula(rng, depth - 1);
  switch (choice) {
    case 0:
      return not(sub());
    case 1:
      return and(sub(), sub());
    case 2:
      return or(sub(), sub());
    case 3:
      return implies(sub(), sub());
    case 4:
      return next(sub());
    case 5:
      return eventually(sub());
    case 6:
      return globally(sub());
    default:
      return until(sub(), sub());
  }
}

function randomVerdict(rng: () => number): PredicateVerdict {
  const r = rng();
  if (r < 0.45) return true;
  if (r < 0.9) return false;
  return 'unevaluable';
}

function randomTrace(rng: () => number): Row[] {
  const len = Math.floor(rng() * 6); // 0..5 positions (includes empty trace)
  return Array.from({ length: len }, () => {
    const row: Row = {};
    for (const atom of ATOMS) row[atom] = randomVerdict(rng);
    return row;
  });
}

test('property: not(F sub) === G(not sub) verdict-for-verdict (both modes)', () => {
  const rng = mulberry32(0xc0ffee);
  for (let iter = 0; iter < 500; iter++) {
    const sub = randomFormula(rng, 3);
    const rows = randomTrace(rng);
    const left = not(eventually(sub));
    const right = globally(not(sub));
    for (const opts of [complete, prefix]) {
      const lv = verdict(left, rows, opts);
      const rv = verdict(right, rows, opts);
      assert.equal(
        lv,
        rv,
        `NNF mismatch (${JSON.stringify(opts)}): ${render(sub)} on ${JSON.stringify(rows)} — ` +
          `not(F)=${lv} vs G(not)=${rv}`,
      );
    }
  }
});

test('property: De Morgan not(a & b) === (!a | !b) verdict-for-verdict', () => {
  const rng = mulberry32(0x1234abcd);
  for (let iter = 0; iter < 300; iter++) {
    const a = randomFormula(rng, 3);
    const b = randomFormula(rng, 3);
    const rows = randomTrace(rng);
    for (const opts of [complete, prefix]) {
      assert.equal(verdict(not(and(a, b)), rows, opts), verdict(or(not(a), not(b)), rows, opts));
    }
  }
});

test('property: every generated formula validates against the schema', () => {
  const rng = mulberry32(0xfeed);
  for (let iter = 0; iter < 500; iter++) {
    const f = randomFormula(rng, 4);
    const res = validateFormula(f);
    assert.equal(res.valid, true, `${render(f)} failed schema: ${res.errors.join('; ')}`);
  }
});

// Re-export schema so a broken schema constant surfaces at import time.
test('schema constant is well-formed (has recursive $ref)', () => {
  assert.equal(formulaSchema.$ref, '#/definitions/formula');
});
