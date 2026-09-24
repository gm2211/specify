/**
 * src/monitor/entailment.ts — Bounded, advisory, refutation-only entailment
 * check for LTLf sub-check decompositions.
 *
 * WHY refutation-only: exact LTLf entailment ("does AND(leaves) semantically
 * imply parent?") needs external model-checking tooling that isn't shippable
 * in this repo, and even where available it blows up on realistic formulas.
 * Meanwhile legitimate decompositions routinely fail *strict* entailment for
 * reasons that aren't bugs. So this module never tries to PROVE entailment —
 * it only tries to DISPROVE it, by bounded search for a counterexample: an
 * assignment-trace (each position assigns true/false to every atom of the
 * joint alphabet) of length 1..k on which every leaf evaluates 'satisfied'
 * while the parent evaluates 'violated', under classical complete-trace
 * semantics (traceComplete: true — entailment is a complete-trace notion).
 *
 *   - A counterexample is a hard fact: "here is a scenario where every
 *     sub-check passes but the parent claim fails". Fully actionable.
 *   - NOT finding one proves nothing. The result's `coverage` field is the
 *     honesty marker: 'exhaustive-to-k' means every assignment-trace up to
 *     length k was checked (still says nothing beyond length k);
 *     'sampled' means only a bounded random subset was checked. Callers MUST
 *     NOT present `refuted: false` as "entailment holds".
 *
 * This is why the lint integration (src/spec/lint.ts, entailment-refuted
 * rule) only ever emits a WARNING on `refuted: true` and stays silent
 * otherwise, including on time-budget exhaustion.
 *
 * The atom-alphabet / seeded-PRNG / assignment-trace machinery this module
 * needs is shared with src/monitor/witness.ts (which searches a single
 * formula's own alphabet for example traces) — see ./trace-search.ts.
 */

import { and, render, type Formula } from './formula.js';
import { evaluate } from './evaluate.js';
import {
  type Assignment,
  type Atom,
  buildTrace,
  collectAtoms,
  decodeCombo,
  EXHAUSTIVE_LIMIT,
  jointAtomAlphabet,
  makeEvaluator,
  mulberry32,
  randomAssignment,
  renderAtom,
  renderTraceTable,
  TIME_CHECK_INTERVAL,
} from './trace-search.js';

export { jointAtomAlphabet };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EntailmentWitness {
  /** Readable assignment table: one line per trace position, one cell per atom. */
  trace: string;
  /** Plain-English counterexample description, safe to surface in a lint message. */
  description: string;
}

export type EntailmentResult =
  | { refuted: true; witness: EntailmentWitness }
  | {
      refuted: false;
      /**
       * 'exhaustive-to-k' — every assignment-trace of length 1..maxLen was
       *   checked. Still not a proof of entailment beyond that bound.
       * 'sampled' — only a bounded random subset was checked (or a time
       *   budget cut an exhaustive pass short).
       */
      coverage: 'exhaustive-to-k' | 'sampled';
      tracesChecked: number;
      /** Present and true when the time budget cut the search short. */
      timedOut?: boolean;
    };

export interface EntailmentOptions {
  /** Maximum trace length searched. Default 6. */
  maxLen?: number;
  /** Maximum traces tried on the sampled path. Default 100_000. */
  maxTraces?: number;
  /** PRNG seed for the sampled path; same seed => same result. Default 42. */
  seed?: number;
  /** Soft wall-clock budget in milliseconds for the whole search. Unbounded if omitted. */
  timeBudgetMs?: number;
}

function describeCounterexample(
  parent: Formula,
  leaves: Formula[],
  atoms: Atom[],
  assignment: Assignment,
  parentWitnessStep: number | undefined,
): string {
  const n = assignment.length;
  const leafList = leaves.map((l) => render(l)).join(' and ');
  const leafClause =
    leaves.length === 1
      ? `the sub-check ${leafList} passes`
      : `every sub-check (${leafList}) passes`;

  const step = parentWitnessStep ?? n - 1;
  const stepClause =
    parentWitnessStep !== undefined
      ? `at step ${parentWitnessStep}`
      : `by the end of the ${n}-step scenario`;

  // Show the truth values of the parent's own atoms at the decisive step.
  const parentAtoms = new Map<string, Atom>();
  collectAtoms(parent, parentAtoms);
  const indexByKey = new Map(atoms.map((a, i) => [a.key, i]));
  const stateDetail = [...parentAtoms.values()]
    .map((a) => `${renderAtom(a)} is ${assignment[step][indexByKey.get(a.key) as number]}`)
    .join(', ');

  return (
    `a scenario where every sub-check passes but the parent claim fails: ` +
    `over a ${n}-step trace ${leafClause}, yet the parent ${render(parent)} is violated ` +
    `${stepClause} (${stateDetail}).`
  );
}

// ---------------------------------------------------------------------------
// Core search
// ---------------------------------------------------------------------------

function tryAssignment(
  parent: Formula,
  leavesConjunction: Formula,
  atoms: Atom[],
  assignment: Assignment,
): { hit: boolean; parentWitnessStep?: number } {
  const trace = buildTrace(assignment.length);
  const evaluator = makeEvaluator(atoms, assignment);

  // Entailment is a complete-trace notion: classical semantics on both sides.
  const leavesResult = evaluate(leavesConjunction, trace, evaluator, { traceComplete: true });
  if (leavesResult.verdict !== 'satisfied') return { hit: false };

  const parentResult = evaluate(parent, trace, evaluator, { traceComplete: true });
  if (parentResult.verdict !== 'violated') return { hit: false };

  return { hit: true, parentWitnessStep: parentResult.witnessStep };
}

/**
 * Bounded refutation-only entailment check: search for a trace on which
 * AND(leaves) is satisfied but `parent` is violated (classical LTLf).
 *
 * NEVER claims entailment is proved — `refuted: false` only reports how much
 * ground was covered (see EntailmentResult.coverage).
 */
export function checkEntailment(
  parent: Formula,
  leaves: Formula[],
  opts: EntailmentOptions = {},
): EntailmentResult {
  const k = Math.max(1, opts.maxLen ?? 6);
  const maxTraces = opts.maxTraces ?? 100_000;
  const deadline = opts.timeBudgetMs !== undefined ? Date.now() + opts.timeBudgetMs : undefined;

  const atomMap = new Map<string, Atom>();
  collectAtoms(parent, atomMap);
  for (const leaf of leaves) collectAtoms(leaf, atomMap);
  const atoms = [...atomMap.values()];
  const m = atoms.length;
  const leavesConjunction = leaves.length === 1 ? leaves[0] : and(...leaves);

  // Path selection: exhaustive iff sum_{n=1..k} (2^m)^n <= EXHAUSTIVE_LIMIT.
  const perPosition = 2 ** m;
  let total = 0;
  let exhaustive = true;
  for (let n = 1; n <= k; n++) {
    total += perPosition ** n;
    if (!Number.isFinite(total) || total > EXHAUSTIVE_LIMIT) {
      exhaustive = false;
      break;
    }
  }

  let tracesChecked = 0;
  const refutedResult = (
    assignment: Assignment,
    parentWitnessStep: number | undefined,
  ): EntailmentResult => ({
    refuted: true,
    witness: {
      trace: renderTraceTable(atoms, assignment),
      description: describeCounterexample(parent, leaves, atoms, assignment, parentWitnessStep),
    },
  });
  const overBudget = (): boolean =>
    deadline !== undefined && tracesChecked % TIME_CHECK_INTERVAL === 0 && Date.now() > deadline;

  if (exhaustive) {
    for (let n = 1; n <= k; n++) {
      const totalN = perPosition ** n;
      for (let combo = 0; combo < totalN; combo++) {
        if (overBudget()) {
          return { refuted: false, coverage: 'sampled', tracesChecked, timedOut: true };
        }
        const assignment = decodeCombo(combo, n, m);
        tracesChecked++;
        const outcome = tryAssignment(parent, leavesConjunction, atoms, assignment);
        if (outcome.hit) return refutedResult(assignment, outcome.parentWitnessStep);
      }
    }
    return { refuted: false, coverage: 'exhaustive-to-k', tracesChecked };
  }

  // Sampled path — seeded, deterministic for a given seed.
  const rng = mulberry32(opts.seed ?? 42);
  for (let i = 0; i < maxTraces; i++) {
    if (overBudget()) {
      return { refuted: false, coverage: 'sampled', tracesChecked, timedOut: true };
    }
    const n = 1 + Math.floor(rng() * k);
    const assignment = randomAssignment(rng, n, m);
    tracesChecked++;
    const outcome = tryAssignment(parent, leavesConjunction, atoms, assignment);
    if (outcome.hit) return refutedResult(assignment, outcome.parentWitnessStep);
  }

  return { refuted: false, coverage: 'sampled', tracesChecked };
}
