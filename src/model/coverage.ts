/**
 * src/model/coverage.ts — Coverage semantics + coverage-directed exploration
 * hints over a learned navigation map (src/model/nav-model.ts).
 *
 * Two responsibilities, both pure and deterministic:
 *
 *   1. COVERAGE. Given a reference navigation model and one or more observation
 *      traces (a verify/capture run's step stream), compute which of the
 *      model's states and transitions those traces actually exercised. "Covered"
 *      is defined precisely and relative to the observed map: a state/transition
 *      is covered iff its abstract key — minted under the model's own template
 *      set and predicate extractor (see nav-model's `signatureOf`) — appears in
 *      the run's trace signature. There is no claim of coverage over the real
 *      target's full behavior; only over the map we have learned so far. This is
 *      what makes "untested" precise: an unvisited key is a page/edge the model
 *      knows exists but this run never touched.
 *
 *   2. EXPLORATION HINTS. Rank the model's states and transitions by how little
 *      they have been exercised — unvisited-by-this-run first (when a coverage
 *      report is supplied), then rarely-visited-overall by cumulative count —
 *      and surface the top-K, each with a mechanically-recorded recipe for how
 *      to reach/trigger it. Rendered into the capture/verify prompt
 *      (src/agent/prompts.ts) as context, these turn open-ended exploration into
 *      coverage-directed prompting and break the staleness of runs converging on
 *      the same happy paths. When the model is empty there are no hints — the
 *      first capture of a target is never steered.
 *
 * Nothing here mutates the model or the traces.
 */

import { signatureOf, arcKey } from './nav-model.js';
import type {
  NavModel,
  ModelTransition,
  Recipe,
  SessionTrace,
  PredicateExtractor,
} from './nav-model.js';
import { TemplateSet } from './url-template.js';

// ---------------------------------------------------------------------------
// Coverage report
// ---------------------------------------------------------------------------

/** Coverage of one axis (states or transitions) of the model. */
export interface AxisCoverage {
  /** Distinct model keys on this axis. */
  known: number;
  /** How many of them the measured trace(s) exercised. */
  visited: number;
  /** visited / known, or 0 when `known` is 0. Range [0, 1]. */
  ratio: number;
  /** Keys the model knows but the trace(s) never touched. Sorted. */
  unvisited: string[];
}

/**
 * Coverage of a navigation model by a set of observation traces. Suitable for
 * embedding in verify-result.json and rendering in the webapp: the scalar
 * `states`/`transitions` ratios are the headline numbers, `unvisited` the
 * drill-down.
 */
export interface CoverageReport {
  specId: string;
  targetKey: string;
  states: AxisCoverage;
  transitions: AxisCoverage;
  /** True when the model has no states — nothing to cover, no hints to emit. */
  empty: boolean;
  /**
   * Set when the supplied extractor's predicate key set did not match the
   * model's `predicateKeys`. State ids were then minted under a different
   * abstraction, so state (and transition) coverage is unreliable — treat the
   * report as advisory and rebuild with the correct extractor.
   */
  predicateMismatch: boolean;
}

export interface CoverageOptions {
  /**
   * The predicate extractor the model was learned with. MUST match, or state
   * ids diverge and everything reads as uncovered (`predicateMismatch` is then
   * set on the report). Default: none (matches a default-abstraction model).
   */
  predicates?: PredicateExtractor;
}

/** All known arc keys of a model, flattened from its transition targets. */
function knownArcs(transitions: ModelTransition[]): string[] {
  const arcs: string[] = [];
  for (const tr of transitions) {
    for (const t of tr.targets) {
      arcs.push(arcKey(tr.from, tr.actionKey, t.to));
    }
  }
  return arcs;
}

function axis(known: string[], visited: Set<string>): AxisCoverage {
  const knownSet = new Set(known);
  let hits = 0;
  const unvisited: string[] = [];
  for (const key of knownSet) {
    if (visited.has(key)) hits += 1;
    else unvisited.push(key);
  }
  return {
    known: knownSet.size,
    visited: hits,
    ratio: knownSet.size === 0 ? 0 : hits / knownSet.size,
    unvisited: unvisited.sort(),
  };
}

/**
 * Compute coverage of `model` by `sessions`. Order-independent and idempotent
 * by session ref (a session listed twice counts once), mirroring the learner.
 */
export function computeCoverage(
  model: NavModel,
  sessions: SessionTrace[],
  opts: CoverageOptions = {},
): CoverageReport {
  const knownStateIds = model.states.map((s) => s.id);
  const arcs = knownArcs(model.transitions);
  const empty = model.states.length === 0;

  if (empty) {
    return {
      specId: model.specId,
      targetKey: model.targetKey,
      states: axis([], new Set()),
      transitions: axis([], new Set()),
      empty: true,
      predicateMismatch: false,
    };
  }

  const templateSet = TemplateSet.fromJSON(model.templates);
  const sig = signatureOf(templateSet, sessions, opts.predicates);

  const modelKeys = [...(model.predicateKeys ?? [])].sort();
  const predicateMismatch = sig.predicateKeys.join(',') !== modelKeys.join(',');

  return {
    specId: model.specId,
    targetKey: model.targetKey,
    states: axis(knownStateIds, sig.stateIds),
    transitions: axis(arcs, sig.arcs),
    empty: false,
    predicateMismatch,
  };
}

/** One-line human summary of a coverage report, e.g. for a CLI/result footer. */
export function renderCoverageSummary(report: CoverageReport): string {
  if (report.empty) return 'Navigation-map coverage: no model learned yet.';
  const s = report.states;
  const t = report.transitions;
  const pct = (a: AxisCoverage) => `${a.visited}/${a.known} (${Math.round(a.ratio * 100)}%)`;
  const warn = report.predicateMismatch ? ' [predicate-extractor mismatch — advisory]' : '';
  return `Navigation-map coverage: states ${pct(s)}, transitions ${pct(t)}${warn}`;
}

// ---------------------------------------------------------------------------
// Exploration hints
// ---------------------------------------------------------------------------

/** A single unexercised/under-exercised model element the agent should target. */
export interface ExplorationHint {
  kind: 'state' | 'transition';
  /**
   * Where the element lives: a state's own urlTemplate, or a transition's
   * from-state urlTemplate.
   */
  urlTemplate: string;
  /**
   * Cumulative observed count across all folded sessions (state.seenCount, or a
   * transition target's count). 0 ⇒ the element is in the model only as an edge
   * endpoint that was never itself landed on.
   */
  seenCount: number;
  /**
   * True when the element was UNVISITED by the coverage report's sessions (when
   * a report was supplied), as opposed to merely rare in the model overall.
   */
  uncovered: boolean;
  /**
   * Mechanically-recorded recipe to exercise the element: for a transition, its
   * own recipe; for a state, the recipe of the most-observed incoming edge (how
   * to reach it). Absent for entry states with no known incoming edge — reach
   * those by navigating to `urlTemplate` directly.
   */
  recipe?: Recipe;
  /** For a state hint with a recipe: the from-state urlTemplate it fires from. */
  fromUrlTemplate?: string;
  /** For a transition hint: the destination state's urlTemplate. */
  toUrlTemplate?: string;
  /** Human-readable one-liner (used by the prompt renderer). */
  label: string;
}

export interface HintOptions {
  /**
   * Annotate/rank against this coverage report: elements unvisited by the
   * report's sessions float above merely-rare ones. Omit to rank purely by
   * cumulative rarity in the model.
   */
  report?: CoverageReport;
  /** Maximum hints to emit. Default 8. */
  limit?: number;
}

const DEFAULT_HINT_LIMIT = 8;

interface RankedHint extends ExplorationHint {
  /** Deterministic tiebreak key. */
  sortKey: string;
}

/**
 * Rank the model's least-exercised states and transitions and return the top
 * `limit`, each with a recipe to reach/trigger it. Returns `[]` for an empty
 * model (so the first capture of a target is never steered). Deterministic:
 * the same model + options always yields byte-identical hints.
 */
export function explorationHints(model: NavModel, opts: HintOptions = {}): ExplorationHint[] {
  if (model.states.length === 0) return [];

  const limit = opts.limit ?? DEFAULT_HINT_LIMIT;
  if (limit <= 0) return [];

  const stateById = new Map(model.states.map((s) => [s.id, s]));
  const uncoveredStates = new Set(opts.report?.states.unvisited ?? []);
  const uncoveredArcs = new Set(opts.report?.transitions.unvisited ?? []);

  // Best (highest-count) incoming edge per destination state, for state recipes.
  const incoming = new Map<string, { recipe: Recipe; from: string; count: number }>();
  for (const tr of model.transitions) {
    for (const t of tr.targets) {
      const prev = incoming.get(t.to);
      if (!prev || t.count > prev.count) {
        incoming.set(t.to, { recipe: tr.recipe, from: tr.from, count: t.count });
      }
    }
  }

  const hints: RankedHint[] = [];

  for (const st of model.states) {
    const via = incoming.get(st.id);
    const fromTemplate = via ? stateById.get(via.from)?.urlTemplate : undefined;
    const uncovered = uncoveredStates.has(st.id);
    hints.push({
      kind: 'state',
      urlTemplate: st.urlTemplate,
      seenCount: st.seenCount,
      uncovered,
      recipe: via?.recipe,
      fromUrlTemplate: fromTemplate,
      label: stateLabel(st.urlTemplate, uncovered, st.seenCount, via?.recipe, fromTemplate),
      sortKey: `state|${st.id}`,
    });
  }

  for (const tr of model.transitions) {
    const fromTemplate = stateById.get(tr.from)?.urlTemplate ?? tr.from;
    for (const t of tr.targets) {
      const toTemplate = stateById.get(t.to)?.urlTemplate ?? t.to;
      const uncovered = uncoveredArcs.has(arcKey(tr.from, tr.actionKey, t.to));
      hints.push({
        kind: 'transition',
        urlTemplate: fromTemplate,
        seenCount: t.count,
        uncovered,
        recipe: tr.recipe,
        fromUrlTemplate: fromTemplate,
        toUrlTemplate: toTemplate,
        label: transitionLabel(fromTemplate, toTemplate, uncovered, t.count, tr.recipe),
        sortKey: `transition|${tr.from}|${tr.actionKey}|${t.to}`,
      });
    }
  }

  hints.sort(compareHints);
  return hints.slice(0, limit).map(({ sortKey: _sortKey, ...h }) => h);
}

/**
 * Ranking: uncovered-by-this-run before merely-rare; then lowest cumulative
 * count first; then states before transitions (reaching a page usually unlocks
 * its edges); then a stable key. Every comparator step is total, so the order
 * is deterministic.
 */
function compareHints(a: RankedHint, b: RankedHint): number {
  if (a.uncovered !== b.uncovered) return a.uncovered ? -1 : 1;
  if (a.seenCount !== b.seenCount) return a.seenCount - b.seenCount;
  if (a.kind !== b.kind) return a.kind === 'state' ? -1 : 1;
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
}

function rarity(uncovered: boolean, seenCount: number): string {
  if (uncovered) return 'never visited this run';
  if (seenCount === 0) return 'never landed on';
  return `only ${seenCount} visit${seenCount === 1 ? '' : 's'}`;
}

function recipePhrase(recipe: Recipe): string {
  const parts = [recipe.action.replace(/^browser_/, '')];
  if (recipe.selector) parts.push(`\`${recipe.selector}\``);
  if (recipe.valueTemplate) parts.push(`→ ${recipe.valueTemplate}`);
  return parts.join(' ');
}

function stateLabel(
  urlTemplate: string,
  uncovered: boolean,
  seenCount: number,
  recipe: Recipe | undefined,
  fromTemplate: string | undefined,
): string {
  const how = recipe
    ? ` — reach via ${recipePhrase(recipe)}${fromTemplate ? ` from \`${fromTemplate}\`` : ''}`
    : ' — reach by navigating there directly';
  return `[${rarity(uncovered, seenCount)}] state \`${urlTemplate}\`${how}`;
}

function transitionLabel(
  fromTemplate: string,
  toTemplate: string,
  uncovered: boolean,
  count: number,
  recipe: Recipe,
): string {
  return `[${rarity(uncovered, count)}] transition from \`${fromTemplate}\` via ${recipePhrase(
    recipe,
  )} → \`${toTemplate}\``;
}

/**
 * Render hints as a prompt-ready markdown block, or '' when there are none (so
 * callers can pass the result straight through and leave the prompt unchanged
 * for an empty model). The wording is deliberately scoped to AFTER the breadth
 * survey — these are steering hints, not a first-pass map.
 */
export function renderExplorationHints(hints: ExplorationHint[]): string {
  if (hints.length === 0) return '';
  const lines = [
    '## Coverage-directed exploration hints',
    '',
    'A navigation map learned from prior runs shows the areas below are',
    'unexercised or rarely visited. These are hints, not a checklist, and they',
    'are relative to what has been observed so far — not a claim about the whole',
    'app. AFTER you have completed your breadth survey, prioritize reaching these',
    'so runs stop converging on the same paths:',
    '',
  ];
  for (const h of hints) {
    lines.push(`- ${h.label}`);
  }
  lines.push('');
  return lines.join('\n');
}
