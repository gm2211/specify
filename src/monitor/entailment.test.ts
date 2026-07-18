import assert from 'node:assert/strict';
import test from 'node:test';

import { and, globally, pred, type Formula } from './formula.js';
import { checkEntailment, jointAtomAlphabet } from './entailment.js';

test('joint atom alphabet deduplicates by name + canonicalized args', () => {
  const parent = globally(and(pred('p'), pred('q', ['a', 'b'])));
  const leaves = [globally(pred('p')), globally(pred('q', ['a', 'b'])), globally(pred('q', ['a']))];
  const atoms = jointAtomAlphabet(parent, leaves);
  const keys = atoms.map((a) => `${a.name}|${a.args.join(',')}`).sort();
  assert.deepEqual(keys, ['p|', 'q|a', 'q|a,b']);
});

test('known-hole decomposition — parent G(p & q), leaves [G(p)] — is refuted with a readable counterexample', () => {
  const parent = globally(and(pred('p'), pred('q')));
  const leaves = [globally(pred('p'))];

  const result = checkEntailment(parent, leaves, { maxLen: 4 });
  assert.equal(result.refuted, true);
  if (!result.refuted) return; // narrow

  // Plain-English description built from the pretty-printer + atom names.
  assert.ok(
    result.witness.description.includes(
      'a scenario where every sub-check passes but the parent claim fails',
    ),
    result.witness.description,
  );
  assert.ok(result.witness.description.includes('G(pred:p & pred:q)'), result.witness.description);
  assert.ok(result.witness.description.includes('violated'), result.witness.description);

  // The assignment table is a step-per-line truth table over both atoms.
  assert.match(result.witness.trace, /step 0: .*p=(true|false), q=(true|false)/);
});

test('sound decomposition — parent G(p), leaves [G(p), G(q)] — reports refuted:false with honest coverage', () => {
  const parent = globally(pred('p'));
  const leaves = [globally(pred('p')), globally(pred('q'))];

  const result = checkEntailment(parent, leaves, { maxLen: 5 });
  assert.equal(result.refuted, false);
  if (result.refuted) return;
  // 2 atoms, maxLen 5: sum_{n=1..5} 4^n = 1364 <= 1M, so exhaustive.
  assert.equal(result.coverage, 'exhaustive-to-k');
  assert.ok(result.tracesChecked > 0);
});

test('never claims entailment proved — the non-refuted shape carries only coverage, no proof flag', () => {
  const result = checkEntailment(globally(pred('p')), [globally(pred('p'))], { maxLen: 3 });
  assert.equal(result.refuted, false);
  if (result.refuted) return;
  assert.ok(result.coverage === 'exhaustive-to-k' || result.coverage === 'sampled');
  assert.ok(!('proved' in result));
  assert.ok(!('entailed' in result));
});

/** Build a formula referencing `count` distinct atoms, to force the sampled path. */
function wideConjunction(count: number): Formula {
  return globally(and(...Array.from({ length: count }, (_, i) => pred(`p${i}`))));
}

test('path selection: small alphabet goes exhaustive, large alphabet falls back to seeded sampling', () => {
  // Small: 2 atoms => exhaustive.
  const small = checkEntailment(globally(pred('a')), [globally(pred('a')), globally(pred('b'))], {
    maxLen: 4,
  });
  assert.equal(small.refuted, false);
  if (!small.refuted) assert.equal(small.coverage, 'exhaustive-to-k');

  // Large: 21 atoms => (2^21)^1 > 1M already, so sampled.
  const parent = wideConjunction(21);
  const leaves = [globally(pred('p0'))];
  const result = checkEntailment(parent, leaves, { maxLen: 4, maxTraces: 300, seed: 7 });
  if (!result.refuted) {
    assert.equal(result.coverage, 'sampled');
    assert.equal(result.tracesChecked, 300);
  }
  // (With 21 atoms a counterexample is likely found by sampling too; either
  // outcome is legitimate — the assertion above is about the path taken.)
});

test('sampled search is deterministic given the same seed', () => {
  const parent = wideConjunction(21);
  const leaves = [globally(pred('p0'))];
  const opts = { maxLen: 4, maxTraces: 500, seed: 12345 };

  const a = checkEntailment(parent, leaves, opts);
  const b = checkEntailment(parent, leaves, opts);
  assert.deepEqual(a, b);

  // A different seed is allowed to differ, but must still be internally
  // deterministic.
  const c1 = checkEntailment(parent, leaves, { ...opts, seed: 99 });
  const c2 = checkEntailment(parent, leaves, { ...opts, seed: 99 });
  assert.deepEqual(c1, c2);
});

test('a refuting sampled run reports the same witness for the same seed', () => {
  // 21 atoms forces sampling; parent demands all atoms hold globally while
  // the single leaf only constrains p0 — counterexamples are dense, so a
  // seeded run finds one quickly and must find the SAME one every time.
  const parent = wideConjunction(21);
  const leaves = [globally(pred('p0'))];
  const opts = { maxLen: 4, maxTraces: 5000, seed: 1 };

  const a = checkEntailment(parent, leaves, opts);
  const b = checkEntailment(parent, leaves, opts);
  assert.deepEqual(a, b);
  if (a.refuted && b.refuted) {
    assert.equal(a.witness.trace, b.witness.trace);
    assert.equal(a.witness.description, b.witness.description);
  }
});

test('a zero time budget aborts the search with timedOut and no refutation claim', () => {
  const parent = globally(and(pred('p'), pred('q')));
  const result = checkEntailment(parent, [globally(pred('p'))], {
    maxLen: 6,
    timeBudgetMs: -1, // already expired
  });
  assert.equal(result.refuted, false);
  if (result.refuted) return;
  assert.equal(result.timedOut, true);
  assert.equal(result.coverage, 'sampled');
});

test('atoms with identical names but different args are distinct alphabet entries', () => {
  // parent: G(resp(200)); leaf: G(resp(404)) — different atoms entirely, so
  // a trace with resp(404) always true and resp(200) false somewhere refutes.
  const parent = globally(pred('http.response', ['200']));
  const leaves = [globally(pred('http.response', ['404']))];
  const result = checkEntailment(parent, leaves, { maxLen: 3 });
  assert.equal(result.refuted, true);
  if (result.refuted) {
    assert.ok(result.witness.description.includes('http.response(200)'), result.witness.description);
  }
});
