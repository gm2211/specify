/**
 * src/agent/probe-plan.ts — Extract a live-sampling plan for dom.* predicates
 * out of a loaded formulas file.
 *
 * WHY
 * ----------------------------------------------------------------------------
 * dom.*-style predicates (src/monitor/predicates.ts) name a live DOM query
 * that can't be answered post-hoc from the recorded trace — unlike http.x,
 * console.x, ax.role etc, there is no mechanically captured artifact to
 * re-read after the run. But APPROVED (and draft) formulas exist BEFORE a verify run
 * starts, so their dom.* predicate nodes can be extracted up front and
 * SAMPLED LIVE at each step (src/cli/commands/capture-agent.ts's
 * executeCommand), recording plain booleans into StepObservation.probes. The
 * monitor tier then stays a pure function over recorded data — see
 * predicates.ts's module notes on the dom.* predicates for the read side of
 * this pipeline.
 *
 * SHADOW MODE NEEDS DATA TOO: draft formulas are sampled exactly like
 * approved ones. A draft's dom.* verdict never affects status
 * (verdict-merge.ts's asymmetric policy), but it can't accumulate the
 * burn-in evidence needed for eventual promotion to 'approved' unless it was
 * actually sampled during the runs it shadowed. 'rejected' formulas are
 * excluded — they are dead and should not slow down every step.
 *
 * DEDUPE: multiple formulas (or multiple positions within one formula) can
 * reference the exact same dom.* invocation (same predicate name + same
 * args). Each distinct invocation should be sampled exactly once per step,
 * so the plan is deduped by `canonicalProbeKey` — the same keying function
 * the recorded probe is looked up by at evaluation time.
 */

import type { Formula, PredFormula } from '../monitor/formula.js';
import type { FormulaEntry, FormulasFile } from '../spec/formulas.js';
import { canonicalProbeKey } from '../monitor/predicates.js';

/** One distinct dom.* invocation to sample live at every step. */
export interface ProbeSpec {
  /** canonicalProbeKey(predicate, args) — the lookup key StepObservation.probes is keyed by. */
  key: string;
  /** Predicate name, e.g. "dom.visible". */
  predicate: string;
  /** Positional predicate args, e.g. ["#toast"]. */
  args: string[];
}

/** A deduped list of dom.* invocations to sample at every step of a run. */
export type ProbePlan = ProbeSpec[];

/** Predicate name prefixes this bead samples live. page.* etc are future work. */
const LIVE_PROBE_PREFIXES = ['dom.'];

function isLiveProbePredicate(name: string): boolean {
  return LIVE_PROBE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Walk a formula AST, collecting every atomic `pred` node (in encounter order, duplicates included). */
function collectPredNodes(formula: Formula, out: PredFormula[]): void {
  switch (formula.op) {
    case 'pred':
      out.push(formula);
      return;
    case 'not':
    case 'X':
    case 'F':
    case 'G':
      collectPredNodes(formula.arg, out);
      return;
    case 'and':
    case 'or':
      for (const arg of formula.args) collectPredNodes(arg, out);
      return;
    case 'implies':
      collectPredNodes(formula.left, out);
      collectPredNodes(formula.right, out);
      return;
    case 'U':
      collectPredNodes(formula.left, out);
      collectPredNodes(formula.right, out);
      break;
  }
}

/** Formula statuses whose dom.* predicates get live-sampled. Approved needs it for verdicts; draft needs it for shadow-mode burn-in. Rejected is dead. */
const SAMPLED_STATUSES: FormulaEntry['status'][] = ['approved', 'draft'];

/**
 * Build a deduped ProbePlan from every dom.* predicate node referenced by any
 * approved or draft formula in `file`. Order is first-encounter (formulas
 * array order, depth-first AST walk); duplicates by canonical key are
 * dropped, keeping the first-seen spec.
 */
export function buildProbePlan(file: FormulasFile): ProbePlan {
  const nodes: PredFormula[] = [];
  for (const entry of file.formulas) {
    if (!SAMPLED_STATUSES.includes(entry.status)) continue;
    collectPredNodes(entry.formula, nodes);
  }

  const seen = new Map<string, ProbeSpec>();
  for (const node of nodes) {
    if (!isLiveProbePredicate(node.name)) continue;
    const args = node.args ?? [];
    const key = canonicalProbeKey(node.name, args);
    if (!seen.has(key)) {
      seen.set(key, { key, predicate: node.name, args });
    }
  }

  return [...seen.values()];
}

/**
 * Build the plan and log its size to stderr (dim, best-effort informational —
 * never throws). Volatile-region guard v1: this is the full extent of the
 * guard for now — just visibility into how many live probes a run pays for
 * per step. No double-sampling / region-collapsing logic yet; kept out of
 * scope deliberately (see SP-efp).
 */
export function buildProbePlanWithLog(file: FormulasFile): ProbePlan {
  const plan = buildProbePlan(file);
  if (plan.length > 0) {
    process.stderr.write(`  \x1b[2mProbe plan: ${plan.length} live DOM probe(s) per step.\x1b[0m\n`);
  }
  return plan;
}
