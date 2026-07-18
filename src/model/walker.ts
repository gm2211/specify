/**
 * src/model/walker.ts — Deterministic model walker + coverage-criteria trace
 * suite generation over a learned navigation map (src/model/nav-model.ts).
 *
 * The navigation-map learner folds runner step traces into a per-target model
 * of states and `(from, actionKey) → target` transitions, each carrying a
 * mechanically-recorded recipe. This module reads that model back OUT: it
 * generates a suite of walks — sequences of transitions each carrying its
 * recorded recipe — that satisfy a coverage criterion over the map. The suite
 * is the substrate a later adversarial mutator library (SP-3fh) perturbs into
 * legal-but-unusual orderings, and a compilation pass (SP-w5d) lowers to an
 * executable script from the recipes.
 *
 * Coverage criteria, in increasing strength:
 *
 *   - all-states: every state the model knows appears in some walk.
 *   - all-transitions: every arc `(from, actionKey, to)` is taken by some walk.
 *     Because an edge can have multiple targets (nondeterminism is data, not an
 *     error — see nav-model), each target is its own arc obligation.
 *   - all-transition-pairs: every feasible pair of consecutive arcs sharing a
 *     middle state `(a, b)` with `a.to === b.from` is taken back-to-back by some
 *     walk. This is 2-switch coverage — the orderings that surface back-button,
 *     double-submit, and revisit bugs. "Where feasible" is precise: the only
 *     pairs are those the graph structurally admits.
 *
 * Strategy: greedy set cover with seeded randomized restarts. Each restart
 * SEEDS a still-uncovered obligation directly (start at the obligation's
 * from-state and force its arc(s)), guaranteeing the obligation is covered, then
 * continues greedily — at each step preferring an outgoing arc that discharges
 * another remaining obligation — until the walk stalls or hits the length bound.
 * Because every arc is reachable by navigating to its from-state's urlTemplate
 * and every pair by forcing its two arcs, coverage is always achievable given
 * enough budget: 100% transition coverage is guaranteed for any model whose
 * obligation count fits under `maxWalks`.
 *
 * Determinism: the suite is a pure function of `(model, options)`. All choices
 * — which uncovered obligation to seed next, which arc to take among
 * equally-scored candidates — are driven by a mulberry32 PRNG seeded from
 * `options.seed` (the repo's seeding convention; see src/monitor/trace-search.ts
 * and src/agent/fault-injector.ts), and every candidate list is sorted by a
 * stable key before the PRNG picks an index. Same seed ⇒ byte-identical suite.
 *
 * Provenance: the emitted suite records the model's schema version, a content
 * hash of the model it was generated from, the seed, the criteria, and the
 * budget. The hash lets a consumer detect that the map has drifted out from
 * under a stored suite (`.specify/traces/<spec>/<target>.json`) and regenerate.
 *
 * This module is pure and browser-free: walks are templated action sequences,
 * not live executions. Nothing here mutates the model.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { arcKey } from './nav-model.js';
import type { NavModel, ModelTransition, Recipe } from './nav-model.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A coverage criterion, in increasing strength. */
export type CoverageCriterion = 'all-states' | 'all-transitions' | 'all-transition-pairs';

/** One transition taken by a walk: a model arc plus its recorded recipe. */
export interface WalkTransition {
  /** Canonical arc key `${from}|${actionKey}|${to}` (see nav-model `arcKey`). */
  arc: string;
  from: string;
  actionKey: string;
  to: string;
  /** The edge's mechanically-recorded recipe — the substrate mutators perturb. */
  recipe: Recipe;
  fromUrlTemplate: string;
  toUrlTemplate: string;
}

/**
 * One generated walk: a start state (reached by navigating to its urlTemplate)
 * followed by a sequence of transitions. A walk with no transitions is a lone
 * state visit — used to cover an isolated state that has no incident arcs.
 */
export interface Trace {
  /** Stable id, `t<index>` in emission order. */
  id: string;
  /** State the walk starts from. */
  startState: string;
  /** urlTemplate of the start state — where execution navigates to first. */
  startUrlTemplate: string;
  transitions: WalkTransition[];
}

/** Coverage of one axis (states, transitions, or pairs) achieved by a suite. */
export interface AxisCoverage {
  /** Distinct model keys on this axis. */
  known: number;
  /** How many of them the suite exercised. */
  covered: number;
  /** covered / known, or 1 when `known` is 0 (nothing to cover). Range [0, 1]. */
  ratio: number;
  /** Keys the model knows but no walk touched. Sorted. */
  uncovered: string[];
}

/** Coverage a suite achieves. `pairs` is present iff pairs were requested. */
export interface SuiteCoverage {
  states: AxisCoverage;
  transitions: AxisCoverage;
  pairs?: AxisCoverage;
}

/** Length + count bounds on the generated suite. */
export interface WalkBudget {
  /** Max transitions in any single walk. Default 50. */
  maxWalkLength: number;
  /** Max walks in the suite. Default 200. */
  maxWalks: number;
}

export interface WalkerOptions {
  /** PRNG seed (mulberry32). Default 1. Same seed ⇒ identical suite. */
  seed?: number;
  /** Criteria to satisfy. Default ['all-states', 'all-transitions']. */
  criteria?: CoverageCriterion[];
  /** Max transitions per walk. Default 50. */
  maxWalkLength?: number;
  /** Max walks in the suite. Default 200. */
  maxWalks?: number;
  /**
   * When a greedy continuation takes this many steps in a row without
   * discharging any remaining obligation, the walk stops (a restart will seed
   * the next obligation directly). Keeps walks purposeful and bounded. Default 3.
   */
  maxStall?: number;
}

/**
 * A generated trace suite plus its provenance and achieved coverage. Suitable
 * for persisting as a reviewable `.specify/traces/<spec>/<target>.json` artifact
 * and for feeding the mutator library.
 */
export interface TraceSuite {
  /** Schema version. */
  version: 1;
  specId: string;
  targetKey: string;
  /** Provenance: the model schema version the suite was generated against. */
  modelVersion: number;
  /** Provenance: content hash of the source model. Detects drift. */
  modelHash: string;
  /** Provenance: PRNG seed used. Re-running with it reproduces the suite. */
  seed: number;
  /** Provenance: criteria the generator aimed to satisfy. */
  criteria: CoverageCriterion[];
  budget: WalkBudget;
  traces: Trace[];
  coverage: SuiteCoverage;
  /**
   * True when a requested obligation could not be covered — either the budget
   * (`maxWalks`) was exhausted, or an obligation needed a walk longer than
   * `maxWalkLength` (e.g. a pair under a length-1 bound).
   */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CRITERIA: CoverageCriterion[] = ['all-states', 'all-transitions'];

export const DEFAULT_BUDGET: WalkBudget = {
  maxWalkLength: 50,
  maxWalks: 200,
};

const DEFAULT_SEED = 1;
const DEFAULT_MAX_STALL = 3;

/** Separator between the two arc keys of a transition-pair key. */
const PAIR_SEP = '>>';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (repo convention; see src/monitor/trace-search.ts).
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
// Internal graph model
// ---------------------------------------------------------------------------

interface Arc {
  key: string;
  from: string;
  actionKey: string;
  to: string;
  recipe: Recipe;
}

/** The transition-pair key for two consecutive arcs `a` then `b` (a.to===b.from). */
export function pairKey(arcA: string, arcB: string): string {
  return `${arcA}${PAIR_SEP}${arcB}`;
}

/** Flatten a model's transition targets into individual arcs, sorted by key. */
function modelArcs(transitions: ModelTransition[]): Arc[] {
  const arcs: Arc[] = [];
  for (const tr of transitions) {
    for (const t of tr.targets) {
      arcs.push({
        key: arcKey(tr.from, tr.actionKey, t.to),
        from: tr.from,
        actionKey: tr.actionKey,
        to: t.to,
        recipe: tr.recipe,
      });
    }
  }
  return arcs.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * All feasible transition pairs: for every state s, the cartesian product of
 * arcs INTO s with arcs OUT OF s. These are exactly the consecutive-arc pairs
 * the graph structurally admits. Sorted by pair key.
 */
function feasiblePairs(arcs: Arc[]): string[] {
  const inTo = new Map<string, Arc[]>();
  const outOf = new Map<string, Arc[]>();
  for (const a of arcs) {
    (inTo.get(a.to) ?? inTo.set(a.to, []).get(a.to)!).push(a);
    (outOf.get(a.from) ?? outOf.set(a.from, []).get(a.from)!).push(a);
  }
  const pairs: string[] = [];
  for (const [mid, ins] of inTo) {
    const outs = outOf.get(mid);
    if (!outs) continue;
    for (const a of ins) {
      for (const b of outs) {
        pairs.push(pairKey(a.key, b.key));
      }
    }
  }
  return pairs.sort();
}

// ---------------------------------------------------------------------------
// Model hash — provenance
// ---------------------------------------------------------------------------

/**
 * Content hash of a model's structure (states + transitions + identity). Two
 * models with the same states and edges hash the same; any structural change
 * changes the hash, so a stored suite can tell whether its source map drifted.
 */
export function modelHashOf(model: NavModel): string {
  const payload = JSON.stringify({
    version: model.version,
    specId: model.specId,
    targetKey: model.targetKey,
    states: model.states.map((s) => s.id),
    transitions: model.transitions.map((tr) => ({
      from: tr.from,
      actionKey: tr.actionKey,
      targets: tr.targets.map((t) => t.to),
    })),
  });
  return createHash('sha256').update(payload, 'utf-8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/** What each requested criterion asks the generator to cover. */
interface Obligations {
  states: boolean;
  arcs: boolean;
  pairs: boolean;
}

function obligationsOf(criteria: CoverageCriterion[]): Obligations {
  return {
    states: criteria.includes('all-states'),
    arcs: criteria.includes('all-transitions') || criteria.includes('all-transition-pairs'),
    pairs: criteria.includes('all-transition-pairs'),
  };
}

/**
 * Generate a coverage-satisfying trace suite over a learned navigation model.
 * Pure and deterministic given `(model, options)`.
 */
export function generateTraceSuite(model: NavModel, options: WalkerOptions = {}): TraceSuite {
  const seed = options.seed ?? DEFAULT_SEED;
  const criteria = options.criteria ?? DEFAULT_CRITERIA;
  const budget: WalkBudget = {
    maxWalkLength: options.maxWalkLength ?? DEFAULT_BUDGET.maxWalkLength,
    maxWalks: options.maxWalks ?? DEFAULT_BUDGET.maxWalks,
  };
  const maxStall = options.maxStall ?? DEFAULT_MAX_STALL;
  const want = obligationsOf(criteria);

  const rng = mulberry32(seed);
  const urlOf = new Map(model.states.map((s) => [s.id, s.urlTemplate]));
  const arcs = modelArcs(model.transitions);
  const arcByKey = new Map(arcs.map((a) => [a.key, a]));

  // Outgoing arcs per state, sorted by key for deterministic iteration.
  const outArcs = new Map<string, Arc[]>();
  for (const a of arcs) {
    (outArcs.get(a.from) ?? outArcs.set(a.from, []).get(a.from)!).push(a);
  }

  // Remaining obligations. Each restart discharges at least one, so the outer
  // loop terminates in at most (initial obligation count) iterations.
  const remainingStates = new Set<string>(want.states ? model.states.map((s) => s.id) : []);
  const remainingArcs = new Set<string>(want.arcs ? arcs.map((a) => a.key) : []);
  const remainingPairs = new Set<string>(want.pairs ? feasiblePairs(arcs) : []);

  // Accumulated coverage across the whole suite (for the final report).
  const coveredStates = new Set<string>();
  const coveredArcs = new Set<string>();
  const coveredPairs = new Set<string>();

  const traces: Trace[] = [];
  let truncated = false;

  const urlTemplateOf = (id: string) => urlOf.get(id) ?? id;

  const toWalk = (a: Arc): WalkTransition => ({
    arc: a.key,
    from: a.from,
    actionKey: a.actionKey,
    to: a.to,
    recipe: a.recipe,
    fromUrlTemplate: urlTemplateOf(a.from),
    toUrlTemplate: urlTemplateOf(a.to),
  });

  /** Record everything a finished walk covered into the accumulators + remaining. */
  const markCovered = (trace: Trace): boolean => {
    let progressed = false;
    const visit = (stateId: string) => {
      if (!coveredStates.has(stateId)) coveredStates.add(stateId);
      if (remainingStates.delete(stateId)) progressed = true;
    };
    visit(trace.startState);
    let prevArc: string | undefined;
    for (const tr of trace.transitions) {
      visit(tr.from);
      visit(tr.to);
      if (!coveredArcs.has(tr.arc)) coveredArcs.add(tr.arc);
      if (remainingArcs.delete(tr.arc)) progressed = true;
      if (prevArc !== undefined) {
        const pk = pairKey(prevArc, tr.arc);
        if (!coveredPairs.has(pk)) coveredPairs.add(pk);
        if (remainingPairs.delete(pk)) progressed = true;
      }
      prevArc = tr.arc;
    }
    return progressed;
  };

  /** Deterministically pick one element of a sorted candidate list via the PRNG. */
  const pick = <T>(sorted: T[]): T => sorted[Math.floor(rng() * sorted.length)];

  /**
   * Choose the next arc out of `current` during a greedy continuation. Prefers
   * arcs that discharge a remaining obligation, in order: a remaining pair with
   * the previous arc, then a remaining arc, then an arc into a remaining state.
   * Returns null when the best available arc discharges nothing (a stall).
   */
  const pickNextArc = (current: string, prevArc: string | undefined): Arc | null => {
    const outs = outArcs.get(current);
    if (!outs || outs.length === 0) return null;
    const score = (a: Arc): number => {
      let s = 0;
      if (prevArc !== undefined && remainingPairs.has(pairKey(prevArc, a.key))) s += 100;
      if (remainingArcs.has(a.key)) s += 10;
      if (remainingStates.has(a.to)) s += 1;
      return s;
    };
    let best = -1;
    for (const a of outs) best = Math.max(best, score(a));
    if (best <= 0) return null; // no progress available from here — stall.
    const top = outs.filter((a) => score(a) === best);
    return pick(top);
  };

  /** Build a walk from `startState`, executing `forced` arcs then continuing greedily. */
  const buildWalk = (startState: string, forced: Arc[]): Trace => {
    const transitions: WalkTransition[] = [];
    let current = startState;
    for (const a of forced) {
      if (transitions.length >= budget.maxWalkLength) break;
      transitions.push(toWalk(a));
      current = a.to;
    }
    let stall = 0;
    while (transitions.length < budget.maxWalkLength) {
      const prevArc = transitions.length > 0 ? transitions[transitions.length - 1].arc : undefined;
      const next = pickNextArc(current, prevArc);
      if (!next) {
        // Nothing productive here. Allow a few bridge steps through already
        // covered arcs to reach fresh territory, then give up (a restart seeds
        // the next obligation directly).
        if (++stall > maxStall) break;
        const outs = outArcs.get(current);
        if (!outs || outs.length === 0) break;
        const bridge = pick([...outs].sort((a, b) => a.key.localeCompare(b.key)));
        transitions.push(toWalk(bridge));
        current = bridge.to;
        continue;
      }
      stall = 0;
      transitions.push(toWalk(next));
      current = next.to;
    }
    return {
      id: `t${traces.length}`,
      startState,
      startUrlTemplate: urlTemplateOf(startState),
      transitions,
    };
  };

  /**
   * Seed the next restart on a still-remaining obligation, strongest first:
   * a pair (force both arcs), else an arc (force it), else a state (start there
   * and walk greedily). Returns null when nothing remains. Marks and skips any
   * obligation that cannot fit under `maxWalkLength`.
   */
  const nextSeed = (): { start: string; forced: Arc[] } | null => {
    while (remainingPairs.size > 0) {
      const pk = pick([...remainingPairs].sort());
      const [aKey, bKey] = pk.split(PAIR_SEP);
      const a = arcByKey.get(aKey);
      const b = arcByKey.get(bKey);
      if (!a || !b) {
        remainingPairs.delete(pk); // defensive; arcs always resolve by construction.
        continue;
      }
      if (budget.maxWalkLength < 2) {
        remainingPairs.delete(pk);
        truncated = true;
        continue;
      }
      return { start: a.from, forced: [a, b] };
    }
    while (remainingArcs.size > 0) {
      const key = pick([...remainingArcs].sort());
      const a = arcByKey.get(key);
      if (!a) {
        remainingArcs.delete(key);
        continue;
      }
      if (budget.maxWalkLength < 1) {
        remainingArcs.delete(key);
        truncated = true;
        continue;
      }
      return { start: a.from, forced: [a] };
    }
    if (remainingStates.size > 0) {
      const id = pick([...remainingStates].sort());
      return { start: id, forced: [] };
    }
    return null;
  };

  while (remainingStates.size + remainingArcs.size + remainingPairs.size > 0) {
    if (traces.length >= budget.maxWalks) {
      truncated = true;
      break;
    }
    const seedSel = nextSeed();
    if (!seedSel) break; // only infeasible obligations remained (already flagged).
    const trace = buildWalk(seedSel.start, seedSel.forced);
    const progressed = markCovered(trace);
    traces.push(trace);
    if (!progressed) {
      // A seeded restart always discharges its obligation, so no progress means
      // the obligation is infeasible under the budget. Bail to avoid a spin.
      truncated = true;
      break;
    }
  }

  const coverage: SuiteCoverage = {
    states: axisCoverage(
      model.states.map((s) => s.id),
      coveredStates,
    ),
    transitions: axisCoverage(
      arcs.map((a) => a.key),
      coveredArcs,
    ),
  };
  if (want.pairs) {
    coverage.pairs = axisCoverage(feasiblePairs(arcs), coveredPairs);
  }

  return {
    version: 1,
    specId: model.specId,
    targetKey: model.targetKey,
    modelVersion: model.version,
    modelHash: modelHashOf(model),
    seed,
    criteria,
    budget,
    traces,
    coverage,
    truncated,
  };
}

/** Coverage of one axis: how many known keys the covered set contains. */
function axisCoverage(known: string[], covered: Set<string>): AxisCoverage {
  const knownSet = new Set(known);
  let hits = 0;
  const uncovered: string[] = [];
  for (const key of knownSet) {
    if (covered.has(key)) hits += 1;
    else uncovered.push(key);
  }
  return {
    known: knownSet.size,
    covered: hits,
    ratio: knownSet.size === 0 ? 1 : hits / knownSet.size,
    uncovered: uncovered.sort(),
  };
}

// ---------------------------------------------------------------------------
// Substrate accessors
// ---------------------------------------------------------------------------

/**
 * The ordered recipe list a walk executes — the substrate the mutator library
 * perturbs. Does NOT include the leading navigation to `startUrlTemplate`
 * (compilation, SP-w5d, emits that from `trace.startUrlTemplate`); these are the
 * recorded transition recipes only.
 */
export function traceRecipes(trace: Trace): Recipe[] {
  return trace.transitions.map((t) => t.recipe);
}

/** One-line human summary of a suite's coverage, e.g. for a CLI/report footer. */
export function renderSuiteSummary(suite: TraceSuite): string {
  const pct = (a: AxisCoverage) => `${a.covered}/${a.known} (${Math.round(a.ratio * 100)}%)`;
  const parts = [
    `states ${pct(suite.coverage.states)}`,
    `transitions ${pct(suite.coverage.transitions)}`,
  ];
  if (suite.coverage.pairs) parts.push(`pairs ${pct(suite.coverage.pairs)}`);
  const warn = suite.truncated ? ' [truncated — budget exhausted]' : '';
  return `Trace suite: ${suite.traces.length} walk${
    suite.traces.length === 1 ? '' : 's'
  }, ${parts.join(', ')}${warn}`;
}

// ---------------------------------------------------------------------------
// Store — reviewable per-target artifact
// ---------------------------------------------------------------------------

/**
 * Resolve the trace-suite file path for a (spec, target) pair. Mirrors the
 * model store's layout: `<spec_root>/.specify/traces/<spec_id>/<target_key>.json`.
 */
export function traceSuitePath(specRootDir: string, specId: string, targetKey: string): string {
  return path.join(
    specRootDir,
    '.specify',
    'traces',
    safeSegment(specId),
    safeSegment(targetKey) + '.json',
  );
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/** Load a suite from disk, or null if absent/unreadable/wrong version. */
export function loadTraceSuite(filePath: string): TraceSuite | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && raw.version === 1 && Array.isArray(raw.traces)) {
      return raw as TraceSuite;
    }
  } catch {
    // Corrupt file: treat as absent so a regeneration can overwrite it cleanly.
  }
  return null;
}

/**
 * Persist a suite as a compact, git-diffable JSON artifact. Atomic: content
 * goes to `<file>.tmp` first, then renames over the target (same pattern as the
 * model store), so a crash mid-write never leaves a truncated suite behind.
 */
export function saveTraceSuite(filePath: string, suite: TraceSuite): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(suite, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * True when a stored suite was generated from a model whose current content
 * hash no longer matches — the map drifted and the suite should be regenerated.
 */
export function suiteIsStale(suite: TraceSuite, model: NavModel): boolean {
  return suite.modelHash !== modelHashOf(model);
}
