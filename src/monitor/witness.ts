/**
 * src/monitor/witness.ts — Witness-example generation for the formula review
 * UX (SP-7lv).
 *
 * WHY: humans review examples well and formulas badly. Grounded NL->formula
 * compilation is reported at 38-74% accuracy in the literature, so the
 * primary defense against a wrong compile is turning "read this LTLf AST and
 * decide if it's right" into "read these short example runs and decide if
 * they match your intent". This module renders each draft formula as a
 * handful of ACCEPTING traces ("a run like this would pass") and REJECTING
 * traces ("a run like this would fail") in plain English, next to the
 * pretty-printed formula (src/monitor/formula.ts's `render`) and the
 * behavior's original description.
 *
 * METHOD: the same bounded assignment-trace search src/monitor/entailment.ts
 * uses for counterexample search (see ./trace-search.ts for the shared
 * machinery) — enumerate short synthetic traces over the formula's own atom
 * alphabet, evaluate each with classical complete-trace semantics
 * (traceComplete: true — a witness trace is meant to be read as a *complete*
 * run, not an in-progress prefix), and keep the ones that land on
 * 'satisfied' (accepting) or 'violated' (rejecting).
 *
 * MINIMALITY: among the traces found, we prefer SHORT traces (fewest
 * positions) and, within a length, MINIMAL traces (fewest true atoms) — the
 * idea being that a witness with fewer moving parts is easier for a human to
 * eyeball and trust. We search length-by-length (shortest first) and, at
 * each length, rank candidates by true-atom count before taking the top N.
 *
 * VACUITY: some formulas can never be violated (tautologies, e.g. `p or not
 * p`, or formulas that only ever get F/G-satisfied vacuously) — that is a
 * review RED FLAG (the formula can't actually catch anything), so when the
 * rejecting search exhausts its bound with zero hits we report that
 * explicitly rather than silently returning an empty list. The dual case
 * (never satisfiable — a contradiction) gets the same treatment for
 * symmetry, though it's rarer in practice.
 */

import { render, type Formula } from './formula.js';
import type { Verdict } from './evaluate.js';
import {
  type Assignment,
  type Atom,
  atomAlphabet,
  decodeCombo,
  EXHAUSTIVE_LIMIT,
  evaluateAssignment,
  mulberry32,
  randomAssignment,
  renderTraceTable,
  trueCount,
} from './trace-search.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Witness {
  /** Number of positions in the synthetic trace. */
  length: number;
  /** Raw assignment table (one line per position), for debugging / advanced review. */
  trace: string;
  /** Plain-English rendering: one line per position, ending in a PASSES/FAILS tag. */
  narrative: string;
}

export interface WitnessResult {
  accepting: Witness[];
  rejecting: Witness[];
  /**
   * True iff the rejecting search exhausted its bound (see `coverage`) and
   * found zero violating traces — a strong signal the formula is a
   * tautology (can never fail) and is therefore vacuous as a check. Always
   * reported explicitly rather than left to be inferred from an empty array.
   */
  vacuousRejecting: boolean;
  /** Dual of `vacuousRejecting`: the formula can never be satisfied either. */
  vacuousAccepting: boolean;
  /** How much of the search space was actually covered — see entailment.ts's EntailmentResult for the same honesty convention. */
  coverage: 'exhaustive-to-k' | 'sampled';
}

export interface WitnessOptions {
  /** Maximum trace length searched. Default 4. */
  maxLen?: number;
  /** Target witness count per category (accepting / rejecting). Default 2. */
  target?: number;
  /** Maximum traces tried on the sampled fallback path. Default 20_000. */
  maxTraces?: number;
  /** PRNG seed for the sampled fallback path; same seed => same result. Default 42. */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Plain-English rendering
// ---------------------------------------------------------------------------

/**
 * Render one atom + its truth value as a plain-English clause, e.g.
 * "a request to /api/login returns 200" or "not: a console error occurred".
 * Falls back to a generic `name(args)` phrasing for predicates this
 * humanizer doesn't special-case (every predicate still renders — it's just
 * less fluent).
 */
function humanizeAtom(atom: Atom, value: boolean): string {
  const [a0, a1, a2] = atom.args;
  const neg = (positive: string, negative: string): string => (value ? positive : negative);

  switch (atom.name) {
    case 'http.request':
      return atom.args.length >= 2
        ? neg(`a ${a0} request to ${a1} occurs`, `no ${a0} request to ${a1} occurs`)
        : neg(`a request to ${a0} occurs`, `no request to ${a0} occurs`);
    case 'http.response':
      return neg(`a response from ${a0} has status ${a1}`, `no response from ${a0} has status ${a1}`);
    case 'http.status_class':
      return neg(`a response from ${a0} is in the ${a1} class`, `no response from ${a0} is in the ${a1} class`);
    case 'http.response_json':
      return neg(
        `a response from ${a0} has JSON field "${a1}" equal to "${a2}"`,
        `no response from ${a0} has JSON field "${a1}" equal to "${a2}"`,
      );
    case 'http.body_matches':
      return neg(`a response body from ${a0} matches /${a1}/`, `no response body from ${a0} matches /${a1}/`);
    case 'http.post_data_matches':
      return neg(`a request body to ${a0} matches /${a1}/`, `no request body to ${a0} matches /${a1}/`);
    case 'http.no_request':
      return neg(`no request to ${a0} occurs`, `a request to ${a0} occurs`);
    case 'console.error':
      return a0
        ? neg(`a console error matching /${a0}/ occurs`, `no console error matching /${a0}/ occurs`)
        : neg(`a console error occurs`, `no console error occurs`);
    case 'console.message':
      return neg(`a console "${a0}" message matching /${a1}/ occurs`, `no console "${a0}" message matching /${a1}/ occurs`);
    case 'step.action':
      return atom.args.length >= 2
        ? neg(`a "${a0}" step on ${a1} happens`, `no "${a0}" step on ${a1} happens`)
        : neg(`a "${a0}" step happens`, `no "${a0}" step happens`);
    case 'page.url':
      return neg(`the page URL matches /${a0}/`, `the page URL does not match /${a0}/`);
    case 'page.title':
      return neg(`the page title matches /${a0}/`, `the page title does not match /${a0}/`);
    case 'ax.role':
      return atom.args.length >= 2
        ? neg(`the accessibility tree has a ${a0} named "${a1}"`, `the accessibility tree has no ${a0} named "${a1}"`)
        : neg(`the accessibility tree has a ${a0}`, `the accessibility tree has no ${a0}`);
    default: {
      const call = atom.args.length > 0 ? `${atom.name}(${atom.args.join(', ')})` : atom.name;
      return neg(`${call} holds`, `${call} does not hold`);
    }
  }
}

/** Render one witness assignment-trace as a plain-English narrative ending in a PASSES/FAILS tag. */
function renderNarrative(atoms: Atom[], assignment: Assignment, accepting: boolean): string {
  const lines = assignment.map((row, i) => {
    const trueClauses = atoms
      .map((a, j) => (row[j] ? humanizeAtom(a, true) : null))
      .filter((s): s is string => s !== null);
    const body = trueClauses.length > 0 ? trueClauses.join('; ') : '(nothing observed at this step)';
    return `step ${i + 1}: ${body}`;
  });
  const tag = accepting ? 'PASSES' : 'FAILS';
  return `${lines.join('\n')} — ${tag}`;
}

function toWitness(atoms: Atom[], assignment: Assignment, accepting: boolean): Witness {
  return {
    length: assignment.length,
    trace: renderTraceTable(atoms, assignment),
    narrative: renderNarrative(atoms, assignment, accepting),
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface Found {
  assignment: Assignment;
  weight: number;
}

/** Exhaustively enumerate every assignment-trace of length `n` over `m` atoms, bucketing by verdict. */
function scanLengthExhaustive(
  formula: Formula,
  atoms: Atom[],
  n: number,
): { accepting: Found[]; rejecting: Found[] } {
  const m = atoms.length;
  const total = (2 ** m) ** n;
  const accepting: Found[] = [];
  const rejecting: Found[] = [];
  for (let combo = 0; combo < total; combo++) {
    const assignment = decodeCombo(combo, n, m);
    const verdict: Verdict = evaluateAssignment(formula, atoms, assignment).verdict;
    if (verdict === 'satisfied') accepting.push({ assignment, weight: trueCount(assignment) });
    else if (verdict === 'violated') rejecting.push({ assignment, weight: trueCount(assignment) });
  }
  return { accepting, rejecting };
}

/** Seeded random sample of assignment-traces (lengths 1..maxLen), bucketed by verdict. */
function scanSampled(
  formula: Formula,
  atoms: Atom[],
  maxLen: number,
  maxTraces: number,
  seed: number,
): { accepting: Found[]; rejecting: Found[] } {
  const m = atoms.length;
  const rng = mulberry32(seed);
  const accepting: Found[] = [];
  const rejecting: Found[] = [];
  for (let i = 0; i < maxTraces; i++) {
    const n = 1 + Math.floor(rng() * maxLen);
    const assignment = randomAssignment(rng, n, m);
    const verdict: Verdict = evaluateAssignment(formula, atoms, assignment).verdict;
    if (verdict === 'satisfied') accepting.push({ assignment, weight: trueCount(assignment) });
    else if (verdict === 'violated') rejecting.push({ assignment, weight: trueCount(assignment) });
  }
  return { accepting, rejecting };
}

function topByWeight(found: Found[], target: number): Assignment[] {
  return found
    .slice()
    .sort((a, b) => a.weight - b.weight || a.assignment.length - b.assignment.length)
    .slice(0, target)
    .map((f) => f.assignment);
}

/**
 * Generate accepting + rejecting witness traces for `formula` — short,
 * minimal (fewest true atoms) example runs, rendered in plain English.
 *
 * Deterministic given the same `opts.seed` (default 42): the exhaustive path
 * is inherently deterministic, and the sampled fallback uses a seeded PRNG.
 */
export function generateWitnesses(formula: Formula, opts: WitnessOptions = {}): WitnessResult {
  const maxLen = Math.max(1, opts.maxLen ?? 4);
  const target = Math.max(1, opts.target ?? 2);
  const maxTraces = opts.maxTraces ?? 20_000;
  const seed = opts.seed ?? 42;

  const atoms = atomAlphabet(formula);
  const m = atoms.length;

  // Path selection: exhaustive iff sum_{n=1..maxLen} (2^m)^n stays bounded —
  // same convention as entailment.ts's checkEntailment.
  const perPosition = 2 ** m;
  let totalSpace = 0;
  let exhaustive = true;
  for (let n = 1; n <= maxLen; n++) {
    totalSpace += perPosition ** n;
    if (!Number.isFinite(totalSpace) || totalSpace > EXHAUSTIVE_LIMIT) {
      exhaustive = false;
      break;
    }
  }

  const acceptingFound: Found[] = [];
  const rejectingFound: Found[] = [];
  let coverage: 'exhaustive-to-k' | 'sampled' = 'exhaustive-to-k';

  if (exhaustive) {
    // Shortest-first: stop growing n once both buckets have enough candidates
    // to pick `target` minimal witnesses from, so short traces are always
    // preferred over merely-minimal-but-longer ones.
    for (let n = 1; n <= maxLen; n++) {
      const { accepting, rejecting } = scanLengthExhaustive(formula, atoms, n);
      acceptingFound.push(...accepting);
      rejectingFound.push(...rejecting);
      if (acceptingFound.length >= target && rejectingFound.length >= target) break;
    }
  } else {
    coverage = 'sampled';
    const { accepting, rejecting } = scanSampled(formula, atoms, maxLen, maxTraces, seed);
    acceptingFound.push(...accepting);
    rejectingFound.push(...rejecting);
  }

  const acceptingAssignments = topByWeight(acceptingFound, target);
  const rejectingAssignments = topByWeight(rejectingFound, target);

  return {
    accepting: acceptingAssignments.map((a) => toWitness(atoms, a, true)),
    rejecting: rejectingAssignments.map((a) => toWitness(atoms, a, false)),
    vacuousRejecting: coverage === 'exhaustive-to-k' && rejectingFound.length === 0,
    vacuousAccepting: coverage === 'exhaustive-to-k' && acceptingFound.length === 0,
    coverage,
  };
}

/** Convenience: pretty-print the formula alongside its witness set (used by the review server / CLI). */
export function describeFormula(formula: Formula, opts: WitnessOptions = {}): { formula: string; witnesses: WitnessResult } {
  return { formula: render(formula), witnesses: generateWitnesses(formula, opts) };
}
