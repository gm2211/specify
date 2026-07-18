/**
 * src/monitor/evaluate.ts — Memoized recursive LTLf evaluator with 4-valued
 * prefix (RV-LTL / LTL3-style) semantics.
 *
 * ==========================================================================
 * VERDICTS (4-valued)
 * ==========================================================================
 *   'satisfied'    — the property is definitely fulfilled on this trace; no
 *                    continuation could retract it.
 *   'violated'     — the property is definitely broken on this trace; no
 *                    continuation could repair it.
 *   'inconclusive' — an obligation remained unresolved when the trace ended.
 *                    Only ever produced in prefix mode (traceComplete:false):
 *                    the run may simply have ended early, so we refuse to claim
 *                    a violation we did not actually witness.
 *   'unevaluable'  — a predicate that MATTERS for the verdict could not be
 *                    evaluated. Kleene "unknown". If the verdict is already
 *                    pinned down by other positions, the determined verdict
 *                    stands and 'unevaluable' does NOT leak up.
 *
 * ==========================================================================
 * TWO EVALUATION MODES ({ traceComplete })
 * ==========================================================================
 *   traceComplete:true  — classical LTLf. The trace is the WHOLE word; nothing
 *                         follows. Unfulfilled future obligations are violations.
 *   traceComplete:false — prefix / RV semantics (default). The trace is a PREFIX
 *                         of a possibly-longer run. A future obligation that has
 *                         not yet been witnessed is 'inconclusive', not violated.
 *
 * The two modes differ ONLY in the value assigned to a formula evaluated over the
 * empty suffix (position == trace length). Everything else is shared recursion.
 *
 *   empty-suffix value        | traceComplete:true | traceComplete:false (prefix)
 *   --------------------------+--------------------+-----------------------------
 *   pred                      | violated           | inconclusive
 *   X φ  (no next state)      | violated           | inconclusive
 *   F φ  (nothing witnessed)  | violated           | inconclusive
 *   G φ  (vacuously)          | satisfied          | inconclusive
 *   φ U ψ (ψ never witnessed) | violated           | inconclusive
 *   not/and/or/implies        | recurse (Kleene, evaluated over the empty suffix)
 *
 * Consequences at the TRACE LEVEL for the documented edge cases:
 *   - X at the last position   -> violated  (strong next; complete mode)
 *                                 inconclusive (prefix mode).
 *   - EMPTY TRACE (length 0), complete mode: G = satisfied, F = violated,
 *     pred = violated  (the standard LTLf convention).
 *   - EMPTY TRACE, prefix mode: G = F = pred = inconclusive (no position has
 *     been observed, so nothing can be asserted about a run that may continue).
 *
 * ==========================================================================
 * THREE/FOUR-VALUED PROPAGATION (Kleene, with a total tie-break order)
 * ==========================================================================
 * The four verdicts form a De-Morgan-dual algebra. `not` swaps satisfied<->
 * violated and fixes inconclusive/unevaluable. `and`/`or` pick by a total
 * precedence so the result is deterministic:
 *
 *   and:  violated  >  unevaluable  >  inconclusive  >  satisfied
 *   or:   satisfied >  unevaluable  >  inconclusive  >  violated
 *
 * Reading:
 *   - `and` with any definite `violated` is `violated` regardless of anything
 *     else (a single false conjunct falsifies the whole — even an unevaluable
 *     sibling cannot rescue it). This is why a determined verdict "wins" over an
 *     unevaluable position.
 *   - otherwise, an `unevaluable` conjunct outranks `inconclusive`: a predicate
 *     we literally could not compute is the more important thing to surface than
 *     plain truncation.
 *   - `or` is the exact dual.
 * These two orders are De-Morgan duals (map satisfied<->violated, fix the middle
 * two), so `not(a & b) == (!a | !b)` and `not(F p) == G(!p)` hold verdict-for-
 * verdict in both modes — see the property tests.
 *
 * ==========================================================================
 * COMPLEXITY
 * ==========================================================================
 * Every (subformula, position) pair is computed at most once and memoized, so
 * evaluation is O(|formula| * n). Comfortably handles 1000-position traces.
 */

import type { Formula } from './formula.js';
import type { PredicateEvaluator, Trace, TraceState } from './trace.js';

export type Verdict = 'satisfied' | 'violated' | 'inconclusive' | 'unevaluable';

export interface EvaluationResult {
  verdict: Verdict;
  /** Decisive position: earliest F-witness, or first G/U-violating position. */
  witnessStep?: number;
  /** Optional human-readable detail, produced via the `describeWitness` callback. */
  witnessDetail?: string;
}

export interface WitnessContext {
  formula: Formula;
  verdict: Verdict;
  position: number;
  state: TraceState;
}

export interface EvaluateOptions {
  /**
   * true  -> classical LTLf (trace is the complete word).
   * false -> prefix / RV semantics (trace is a prefix). Default: false.
   */
  traceComplete?: boolean;
  /** Callback to render a witness detail string for the decisive position. */
  describeWitness?: (ctx: WitnessContext) => string;
}

/** Internal evaluated value: a verdict plus the decisive witness position. */
interface Val {
  v: Verdict;
  /** Decisive position for this subformula's verdict, if any. */
  w?: number;
}

// --- 4-valued combinators -----------------------------------------------------

function notVerdict(v: Verdict): Verdict {
  if (v === 'satisfied') return 'violated';
  if (v === 'violated') return 'satisfied';
  return v; // inconclusive / unevaluable are self-dual
}

function notVal(a: Val): Val {
  return { v: notVerdict(a.v), w: a.w };
}

// Precedence tables. Lower index = higher priority (picked first).
const AND_ORDER: Verdict[] = ['violated', 'unevaluable', 'inconclusive', 'satisfied'];
const OR_ORDER: Verdict[] = ['satisfied', 'unevaluable', 'inconclusive', 'violated'];

function combine(vals: Val[], order: Verdict[], identity: Verdict): Val {
  if (vals.length === 0) return { v: identity };
  let best = vals[0];
  let bestRank = order.indexOf(best.v);
  for (let i = 1; i < vals.length; i++) {
    const rank = order.indexOf(vals[i].v);
    if (rank < bestRank) {
      best = vals[i];
      bestRank = rank;
    }
  }
  // Witness = the decisive child's witness (first violated for `and`, first
  // satisfied for `or`); undefined when the winning verdict has no position.
  return { v: best.v, w: best.w };
}

// `and` identity is satisfied (empty conjunction is true); `or` identity is
// violated (empty disjunction is false).
function andVals(vals: Val[]): Val {
  return combine(vals, AND_ORDER, 'satisfied');
}

function orVals(vals: Val[]): Val {
  return combine(vals, OR_ORDER, 'violated');
}

// --- Node identity for memoization -------------------------------------------

/** Collect every subformula node once, assigning each a stable integer id. */
function collectNodes(root: Formula): Map<Formula, number> {
  const ids = new Map<Formula, number>();
  const walk = (f: Formula): void => {
    if (ids.has(f)) return;
    ids.set(f, ids.size);
    switch (f.op) {
      case 'pred':
        break;
      case 'not':
      case 'X':
      case 'F':
      case 'G':
        walk(f.arg);
        break;
      case 'and':
      case 'or':
        for (const a of f.args) walk(a);
        break;
      case 'implies':
      case 'U':
        walk(f.left);
        walk(f.right);
        break;
    }
  };
  walk(root);
  return ids;
}

/**
 * Evaluate a formula over a trace under prefix (default) or complete-trace LTLf
 * semantics.
 */
export function evaluate(
  formula: Formula,
  trace: Trace,
  evaluator: PredicateEvaluator,
  options: EvaluateOptions = {},
): EvaluationResult {
  const traceComplete = options.traceComplete ?? false;
  const n = trace.length;
  const ids = collectNodes(formula);
  // Memo keyed by nodeId * (n + 1) + position. Positions range over [0, n];
  // position n is the empty suffix.
  const memo = new Map<number, Val>();

  // Empty-suffix ("off the end") base value for a temporal/atomic node.
  const emptyPred = (): Val => ({ v: traceComplete ? 'violated' : 'inconclusive' });
  const emptyF = (): Val => ({ v: traceComplete ? 'violated' : 'inconclusive' });
  const emptyG = (): Val => ({ v: traceComplete ? 'satisfied' : 'inconclusive' });
  const emptyU = (): Val => ({ v: traceComplete ? 'violated' : 'inconclusive' });
  const emptyX = (): Val => ({ v: traceComplete ? 'violated' : 'inconclusive' });

  const evalAt = (f: Formula, i: number): Val => {
    const key = (ids.get(f) as number) * (n + 1) + i;
    const cached = memo.get(key);
    if (cached) return cached;

    let result: Val;
    switch (f.op) {
      case 'pred': {
        if (i >= n) {
          result = emptyPred();
          break;
        }
        const r = evaluator.eval({ name: f.name, args: f.args ?? [] }, trace[i]);
        const v: Verdict = r === true ? 'satisfied' : r === false ? 'violated' : 'unevaluable';
        result = { v, w: i };
        break;
      }
      case 'not':
        result = notVal(evalAt(f.arg, i));
        break;
      case 'and':
        result = andVals(f.args.map((a) => evalAt(a, i)));
        break;
      case 'or':
        result = orVals(f.args.map((a) => evalAt(a, i)));
        break;
      case 'implies':
        // left -> right  ===  (!left) | right
        result = orVals([notVal(evalAt(f.left, i)), evalAt(f.right, i)]);
        break;
      case 'X':
        // Strong next: requires an actual next position. If none exists
        // (i is the last position, or we are already off the end), the empty-X
        // base value applies.
        result = i + 1 >= n ? emptyX() : evalAt(f.arg, i + 1);
        break;
      case 'F':
        // F φ ≡ φ ∨ X(F φ). `or` keeps the earliest satisfying witness.
        result = i >= n ? emptyF() : orVals([evalAt(f.arg, i), evalAt(f, i + 1)]);
        break;
      case 'G':
        // G φ ≡ φ ∧ X(G φ). `and` keeps the earliest violating witness.
        result = i >= n ? emptyG() : andVals([evalAt(f.arg, i), evalAt(f, i + 1)]);
        break;
      case 'U':
        // φ U ψ ≡ ψ ∨ (φ ∧ X(φ U ψ)).
        result =
          i >= n
            ? emptyU()
            : orVals([evalAt(f.right, i), andVals([evalAt(f.left, i), evalAt(f, i + 1)])]);
        break;
    }

    memo.set(key, result);
    return result;
  };

  const top = evalAt(formula, 0);
  const out: EvaluationResult = { verdict: top.v };
  if (top.w !== undefined && top.w < n) {
    out.witnessStep = top.w;
    if (options.describeWitness) {
      out.witnessDetail = options.describeWitness({
        formula,
        verdict: top.v,
        position: top.w,
        state: trace[top.w],
      });
    }
  }
  return out;
}
