/**
 * src/monitor/vacuity.test.ts — Vacuity detection over synthetic traces.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { and, globally, implies, not, pred } from './formula.js';
import { evaluate } from './evaluate.js';
import { predicateEvaluator, type PredicateVerdict, type Trace, type TraceState } from './trace.js';
import { isVacuouslySatisfied } from './vacuity.js';

/** Bare positions; predicate values come entirely from the evaluator's lookup table. */
function buildTrace(length: number): Trace {
  const trace: Trace = [];
  for (let i = 0; i < length; i++) {
    trace.push({ index: i, events: [], step: undefined });
  }
  return trace;
}

function evaluatorFrom(table: Record<string, boolean[]>) {
  return predicateEvaluator((p, state: TraceState): PredicateVerdict => {
    const series = table[p.name];
    if (!series) return 'unevaluable';
    return series[state.index] ?? false;
  });
}

test('isVacuouslySatisfied: false when the formula has no implies node', () => {
  const trace = buildTrace(3);
  const evaluator = evaluatorFrom({ a: [true, true, true] });
  assert.equal(isVacuouslySatisfied(pred('a'), trace, evaluator, { traceComplete: true }), false);
  assert.equal(isVacuouslySatisfied(globally(pred('a')), trace, evaluator, { traceComplete: true }), false);
});

test('isVacuouslySatisfied: true when the antecedent never held anywhere in the trace', () => {
  const trace = buildTrace(4);
  const evaluator = evaluatorFrom({
    submit: [false, false, false, false],
    saved: [false, false, false, false],
  });
  const formula = globally(implies(pred('submit'), pred('saved')));
  // G(submit -> saved) IS satisfied here — submit is never true, so the
  // implication holds vacuously at every position.
  const result = evaluate(formula, trace, evaluator, { traceComplete: true });
  assert.equal(result.verdict, 'satisfied');
  assert.equal(isVacuouslySatisfied(formula, trace, evaluator, { traceComplete: true }), true);
});

test('isVacuouslySatisfied: false when the antecedent fires at least once and the consequence holds', () => {
  const trace = buildTrace(4);
  const evaluator = evaluatorFrom({
    submit: [false, true, false, false],
    saved: [false, true, false, false],
  });
  const formula = globally(implies(pred('submit'), pred('saved')));
  const result = evaluate(formula, trace, evaluator, { traceComplete: true });
  assert.equal(result.verdict, 'satisfied');
  assert.equal(isVacuouslySatisfied(formula, trace, evaluator, { traceComplete: true }), false, 'antecedent fired and held meaningfully');
});

test('isVacuouslySatisfied: an unevaluable antecedent is not treated as evidence of vacuity', () => {
  const trace = buildTrace(3);
  const evaluator = evaluatorFrom({
    // 'submit' has no series -> always 'unevaluable'.
    saved: [true, true, true],
  });
  const formula = globally(implies(pred('submit'), pred('saved')));
  assert.equal(isVacuouslySatisfied(formula, trace, evaluator, { traceComplete: true }), false);
});

test('isVacuouslySatisfied: refuses to claim vacuity on an incomplete trace', () => {
  const trace = buildTrace(4);
  const evaluator = evaluatorFrom({
    submit: [false, false, false, false],
    saved: [false, false, false, false],
  });
  const formula = globally(implies(pred('submit'), pred('saved')));
  // Same never-fired-antecedent fixture as the positive test above — but a
  // partial trace cannot prove the antecedent never fired (it may simply not
  // have been captured yet), so the guard must return false.
  assert.equal(isVacuouslySatisfied(formula, trace, evaluator, { traceComplete: false }), false);
});

test('isVacuouslySatisfied: nested implies inside and/or/not is still found', () => {
  const trace = buildTrace(3);
  const evaluator = evaluatorFrom({
    a: [false, false, false],
    b: [true, true, true],
    c: [true, true, true],
  });
  const formula = and(implies(pred('a'), pred('b')), pred('c'));
  assert.equal(isVacuouslySatisfied(formula, trace, evaluator, { traceComplete: true }), true);

  const formulaNot = not(implies(pred('a'), pred('b')));
  assert.equal(isVacuouslySatisfied(formulaNot, trace, evaluator, { traceComplete: true }), true);
});
