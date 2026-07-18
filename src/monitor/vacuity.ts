/**
 * src/monitor/vacuity.ts — Vacuity detection for implication formulas.
 *
 * WHY: `G(click(#submit) -> F(resp(/api/save, 200)))` is trivially satisfied
 * on any run where the antecedent (`click(#submit)`) never fires — the
 * formula never had a chance to be tested. A "satisfied" verdict on such a
 * run is real but hollow: it says nothing about whether the consequence
 * actually holds when it matters, and a compiled corpus stuffed with
 * vacuous passes would make shadow-mode agreement tracking (formula-stats.ts)
 * look far healthier than it is. This module flags that case so callers can
 * report it distinctly rather than count it as a meaningful pass.
 *
 * APPROACH: for each `implies` subformula reachable from the root (only the
 * AST's `implies` node counts — that's what the compiler actually emits),
 * ask "did the antecedent ever hold anywhere in this trace?" via
 * `F(antecedent)` evaluated under COMPLETE-trace semantics (a whole-trace
 * existence question, not a prefix one — we want "did it happen at all",
 * not "might it still happen"). If it never held (verdict 'violated') for
 * ANY implies node in the formula, the overall satisfied verdict is
 * considered vacuous. An 'unevaluable' antecedent is NOT treated as
 * evidence of vacuity (we can't tell either way) — only a definite
 * 'violated' (never witnessed) counts.
 */

import { eventually, type Formula } from './formula.js';
import { evaluate } from './evaluate.js';
import type { PredicateEvaluator, Trace } from './trace.js';

/** Collect every `implies` node's antecedent (left side) reachable from the root. */
function collectAntecedents(formula: Formula, out: Formula[]): void {
  switch (formula.op) {
    case 'pred':
      return;
    case 'not':
    case 'X':
    case 'F':
    case 'G':
      collectAntecedents(formula.arg, out);
      return;
    case 'and':
    case 'or':
      for (const arg of formula.args) collectAntecedents(arg, out);
      return;
    case 'implies':
      out.push(formula.left);
      collectAntecedents(formula.left, out);
      collectAntecedents(formula.right, out);
      return;
    case 'U':
      collectAntecedents(formula.left, out);
      collectAntecedents(formula.right, out);
      return;
  }
}

export interface VacuityOptions {
  /**
   * Whether `trace` is the COMPLETE record of the observation window. The
   * "did the antecedent ever fire?" question is only answerable on a
   * complete record — on a partial/truncated trace the antecedent may
   * simply not have been captured yet, and labeling that "vacuous" would be
   * a false positive (which, downstream, would wrongly neutralize
   * shadow-mode agreement evidence and stall promotion). When false, this
   * function refuses to claim vacuity and returns false.
   *
   * NOTE this is a different question from the prefix semantics used for
   * formula VERDICTS (verdict-merge.ts evaluates with traceComplete: false
   * because the run is a truncated window of the system's ongoing life).
   * The runner's recorded trace IS the complete record of what happened
   * during the run window, so the merge passes true here.
   */
  traceComplete: boolean;
}

/**
 * True iff `formula` has at least one `implies` node whose antecedent
 * definitely never held anywhere in `trace` (so any 'satisfied' verdict for
 * the whole formula rests on vacuous truth for that implication). Only
 * meaningful to call when the formula's own verdict was 'satisfied' —
 * callers are expected to gate on that themselves (see verdict-merge.ts).
 */
export function isVacuouslySatisfied(
  formula: Formula,
  trace: Trace,
  evaluator: PredicateEvaluator,
  opts: VacuityOptions,
): boolean {
  // A partial trace cannot prove the antecedent never fired — refuse to
  // claim vacuity rather than risk a false positive (see VacuityOptions).
  if (!opts.traceComplete) return false;

  const antecedents: Formula[] = [];
  collectAntecedents(formula, antecedents);
  if (antecedents.length === 0) return false;

  for (const antecedent of antecedents) {
    // "Did this ever hold?" is a whole-trace existence question: complete
    // semantics, not prefix — a run that ends before the antecedent could
    // conceivably still fire is not evidence either way (that's exactly
    // what 'unevaluable'/'inconclusive' would mean here), so use
    // traceComplete: true and only trust a definite 'violated'.
    const result = evaluate(eventually(antecedent), trace, evaluator, { traceComplete: true });
    if (result.verdict === 'violated') return true;
  }
  return false;
}
