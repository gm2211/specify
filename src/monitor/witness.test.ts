import assert from 'node:assert/strict';
import test from 'node:test';

import { and, eventually, globally, not, or, pred, type Formula } from './formula.js';
import { generateWitnesses } from './witness.js';

test('generateWitnesses finds both accepting and rejecting traces for a normal formula', () => {
  const formula: Formula = eventually(pred('http.response', ['/api/login', '200']));
  const result = generateWitnesses(formula, { maxLen: 3 });

  assert.ok(result.accepting.length >= 2, 'expected at least 2 accepting witnesses');
  assert.ok(result.rejecting.length >= 2, 'expected at least 2 rejecting witnesses');
  assert.equal(result.vacuousAccepting, false);
  assert.equal(result.vacuousRejecting, false);
  assert.equal(result.coverage, 'exhaustive-to-k');

  // Plain-English rendering: names the predicate + a PASSES/FAILS tag.
  for (const w of result.accepting) {
    assert.match(w.narrative, /step 1:/);
    assert.match(w.narrative, /— PASSES$/);
    assert.ok(w.narrative.includes('/api/login') || w.narrative.includes('200'));
  }
  for (const w of result.rejecting) {
    assert.match(w.narrative, /— FAILS$/);
  }
});

test('accepting witnesses are minimal — fewest true atoms first', () => {
  const formula: Formula = or(pred('a'), pred('b'));
  const result = generateWitnesses(formula, { maxLen: 2, target: 2 });
  assert.ok(result.accepting.length >= 1);
  // The single shortest, single-true-atom trace should win over any 2-position
  // or 2-true-atom alternative.
  assert.equal(result.accepting[0].length, 1);
});

test('a tautology reports no rejecting witnesses and flags vacuousRejecting explicitly', () => {
  const formula: Formula = or(pred('p'), not(pred('p')));
  const result = generateWitnesses(formula, { maxLen: 3 });

  assert.equal(result.rejecting.length, 0);
  assert.equal(result.vacuousRejecting, true, 'a tautology can never fail — must be flagged');
  assert.ok(result.accepting.length >= 1);
  assert.equal(result.vacuousAccepting, false);
});

test('a contradiction reports no accepting witnesses and flags vacuousAccepting explicitly', () => {
  const formula: Formula = and(pred('p'), not(pred('p')));
  const result = generateWitnesses(formula, { maxLen: 3 });

  assert.equal(result.accepting.length, 0);
  assert.equal(result.vacuousAccepting, true);
  assert.ok(result.rejecting.length >= 1);
});

test('generateWitnesses is deterministic given the same seed (sampled path, large alphabet)', () => {
  // 8 distinct atoms pushes the search space well past the exhaustive limit
  // for maxLen 4, forcing the sampled fallback path.
  const atoms = Array.from({ length: 8 }, (_, i) => pred(`atom${i}`));
  const formula: Formula = globally(and(...atoms));

  const r1 = generateWitnesses(formula, { maxLen: 4, seed: 7 });
  const r2 = generateWitnesses(formula, { maxLen: 4, seed: 7 });

  assert.equal(r1.coverage, 'sampled');
  assert.deepEqual(r1.accepting.map((w) => w.trace), r2.accepting.map((w) => w.trace));
  assert.deepEqual(r1.rejecting.map((w) => w.trace), r2.rejecting.map((w) => w.trace));
});

test('unknown predicate names still render (generic fallback), never throw', () => {
  const formula: Formula = eventually(pred('some.custom.predicate', ['x', 'y']));
  const result = generateWitnesses(formula, { maxLen: 2 });
  assert.ok(result.accepting.length >= 1);
  assert.ok(result.accepting[0].narrative.includes('some.custom.predicate'));
});
