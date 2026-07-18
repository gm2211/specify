/**
 * src/monitor/trace-search.ts — Shared machinery for searching short synthetic
 * assignment-traces over a formula's atom alphabet.
 *
 * Extracted from src/monitor/entailment.ts so a second bounded-search
 * consumer (src/monitor/witness.ts, which enumerates accepting/rejecting
 * example traces for the formula review UX) doesn't have to re-derive the
 * atom alphabet / seeded PRNG / assignment-decoding machinery. Both modules
 * evaluate `Formula`s over synthetic traces where every position assigns a
 * boolean to every atom — entailment.ts searches a JOINT alphabet across a
 * parent + leaves, witness.ts searches a single formula's own alphabet, but
 * the trace representation and enumeration strategy are identical.
 */

import { evaluate } from './evaluate.js';
import { predicateEvaluator, type PredicateRef, type PredicateVerdict, type Trace } from './trace.js';
import type { Formula } from './formula.js';

// ---------------------------------------------------------------------------
// Joint atom alphabet
// ---------------------------------------------------------------------------

export interface Atom {
  /** Identity key: name + canonicalized args. */
  key: string;
  name: string;
  args: string[];
}

export function atomKey(name: string, args: string[] | undefined): string {
  return `${name} ${(args ?? []).join(' ')}`;
}

export function collectAtoms(formula: Formula, into: Map<string, Atom>): void {
  switch (formula.op) {
    case 'pred': {
      const key = atomKey(formula.name, formula.args);
      if (!into.has(key)) into.set(key, { key, name: formula.name, args: formula.args ?? [] });
      return;
    }
    case 'not':
    case 'X':
    case 'F':
    case 'G':
      collectAtoms(formula.arg, into);
      return;
    case 'and':
    case 'or':
      for (const arg of formula.args) collectAtoms(arg, into);
      return;
    case 'implies':
    case 'U':
      collectAtoms(formula.left, into);
      collectAtoms(formula.right, into);
      break;
  }
}

/** All distinct atoms across parent + leaves (identity = name + canonicalized args). */
export function jointAtomAlphabet(parent: Formula, leaves: Formula[]): PredicateRef[] {
  const into = new Map<string, Atom>();
  collectAtoms(parent, into);
  for (const leaf of leaves) collectAtoms(leaf, into);
  return [...into.values()].map((a) => ({ name: a.name, args: a.args }));
}

/** All distinct atoms across an arbitrary set of formulas (single-formula callers, e.g. witness.ts). */
export function atomAlphabet(...formulas: Formula[]): Atom[] {
  const into = new Map<string, Atom>();
  for (const f of formulas) collectAtoms(f, into);
  return [...into.values()];
}

export function renderAtom(a: Atom): string {
  return a.args.length > 0 ? `${a.name}(${a.args.join(', ')})` : a.name;
}

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Deterministic for a given seed.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Assignment traces
// ---------------------------------------------------------------------------

/** assignment[position][atomIndex] — the truth value of each atom at each step. */
export type Assignment = boolean[][];

export function buildTrace(length: number): Trace {
  return Array.from({ length }, (_, index) => ({ index, events: [] }));
}

export function makeEvaluator(atoms: Atom[], assignment: Assignment) {
  const indexByKey = new Map(atoms.map((a, i) => [a.key, i]));
  return predicateEvaluator((pred: PredicateRef, state): PredicateVerdict => {
    const idx = indexByKey.get(atomKey(pred.name, pred.args));
    if (idx === undefined) return 'unevaluable'; // outside the joint alphabet; unreachable by construction
    return assignment[state.index][idx];
  });
}

/**
 * Decode assignment-trace number `combo` (0-based) of length `n` over an
 * m-atom alphabet into a boolean matrix. Enumerating combo over [0, (2^m)^n)
 * covers every assignment-trace of that length exactly once.
 */
export function decodeCombo(combo: number, n: number, m: number): Assignment {
  const perPosition = 2 ** m;
  const out: Assignment = [];
  let remaining = combo;
  for (let p = 0; p < n; p++) {
    let cell = remaining % perPosition;
    remaining = Math.floor(remaining / perPosition);
    const bits: boolean[] = [];
    for (let a = 0; a < m; a++) {
      bits.push((cell & 1) === 1);
      cell >>= 1;
    }
    out.push(bits);
  }
  return out;
}

export function randomAssignment(rng: () => number, n: number, m: number): Assignment {
  return Array.from({ length: n }, () => Array.from({ length: m }, () => rng() < 0.5));
}

/** Total number of `true` cells in an assignment — used to rank traces by minimality. */
export function trueCount(assignment: Assignment): number {
  let count = 0;
  for (const row of assignment) {
    for (const cell of row) {
      if (cell) count++;
    }
  }
  return count;
}

export function renderTraceTable(atoms: Atom[], assignment: Assignment): string {
  return assignment
    .map((row, i) => `step ${i}: ${atoms.map((a, j) => `${renderAtom(a)}=${row[j]}`).join(', ')}`)
    .join('\n');
}

/** Evaluate `formula` over a synthetic assignment-trace under classical (complete-trace) LTLf semantics. */
export function evaluateAssignment(formula: Formula, atoms: Atom[], assignment: Assignment) {
  const trace = buildTrace(assignment.length);
  const evaluator = makeEvaluator(atoms, assignment);
  return evaluate(formula, trace, evaluator, { traceComplete: true });
}

/** Exhaustive enumeration is used when sum over n=1..k of (2^|A|)^n stays under this. */
export const EXHAUSTIVE_LIMIT = 1_000_000;
/** How often (in traces) a time budget is re-checked. */
export const TIME_CHECK_INTERVAL = 1024;
