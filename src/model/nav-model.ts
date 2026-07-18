/**
 * src/model/nav-model.ts — Passive navigation-model learner + store.
 *
 * A navigation map (NOT a learned automaton) inferred *passively* by folding
 * over the per-step observation traces Specify already records
 * (src/agent/observation.ts). There is no active automata learning here — no
 * membership/equivalence queries, no resets against the live target. We only
 * read back what the runner already saw.
 *
 * The model has three parts:
 *
 *   - States: a page abstracted to `hash(urlTemplate + sortedPredicateBits)`.
 *     The URL is collapsed to a template via the cross-observation clustering
 *     in src/model/url-template.ts, so `/users/1` and `/users/2` are the same
 *     state. Predicates are coarse, OPT-IN page-type affordance bits supplied
 *     by a caller-provided extractor; by default there are none, so state
 *     identity is the URL template alone. The raw AX digest is deliberately
 *     NOT baked into state identity — every content edit would mint a new
 *     state and explode the space. It is passed to the predicate extractor as
 *     a signal instead.
 *
 *   - Transitions: an edge keyed by `(fromState, actionKey)` where
 *     `actionKey = hash(actionType + normalizedSelector)`. Each edge carries a
 *     mechanically-recorded `recipe` ({action, selector, valueTemplate}) taken
 *     straight from the step record — never reconstructed from prose memory or
 *     playbooks — which is what makes later trace-to-script compilation
 *     deterministic. An edge holds MULTIPLE targets: nondeterminism (A/B
 *     tests, personalization, races) is data, not an error. Each target has
 *     its own count, lastSeen, and network signature.
 *
 *   - Recipes: the action + selector + value-template captured per transition
 *     target (see above). Fill values are never recorded (they may carry
 *     credentials), so `valueTemplate` is only populated for navigation-style
 *     args (a templated URL).
 *
 * Determinism: `learn()` is a pure, order-independent fold — a shuffled input
 * corpus produces a byte-identical model. Re-learning the same session set is
 * idempotent. `mergeSessions()` folds additional sessions incrementally and is
 * idempotent by session ref (re-adding a folded session is a no-op).
 *
 * Persistence: `.specify/model/<spec_id>/<target_key>.json`, a compact,
 * git-diffable artifact meant to be reviewed by a human.
 *
 * Do NOT wire this to src/cli/interactive/crawler.ts — that is a fetch+href
 * crawler with no JS execution and a hardcoded-empty apiCalls field. The
 * learner consumes agent-session step traces only.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StepObservation, AxObservation } from '../agent/observation.js';
import type { CapturedTraffic } from '../capture/types.js';
import { inferTemplates, TemplateSet } from './url-template.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';

/** One entry of a transition target's network signature (order-independent). */
export interface NetworkSignatureEntry {
  method: string;
  urlTemplate: string;
  statusClass: StatusClass;
}

/** Mechanically-recorded action recipe. Never reconstructed from prose. */
export interface Recipe {
  /** The browser/CLI action type, e.g. 'browser_click', 'browser_goto'. */
  action: string;
  /** Normalized selector, when the action carried one. */
  selector?: string;
  /**
   * Template of a navigation value (e.g. a templated goto URL). Fill/type
   * values are never recorded, so this stays undefined for those actions.
   */
  valueTemplate?: string;
}

/** One destination reached by an edge. Multiple targets ⇒ nondeterminism. */
export interface TransitionTarget {
  /** Destination state id. */
  to: string;
  /** How many times this (from, actionKey) → to arc was observed. */
  count: number;
  /** Latest tsEnd (ms) at which this arc was observed. */
  lastSeen: number;
  /** Deduped, sorted network signature observed while taking this arc. */
  networkSignature: NetworkSignatureEntry[];
}

/** An edge keyed by (from, actionKey). Holds one recipe and >=1 targets. */
export interface ModelTransition {
  from: string;
  /** hash(actionType + normalizedSelector). */
  actionKey: string;
  recipe: Recipe;
  targets: TransitionTarget[];
}

/** An abstracted page. */
export interface ModelState {
  /** hash(urlTemplate + sortedPredicateBits). */
  id: string;
  urlTemplate: string;
  /** Coarse, opt-in page-type affordance bits. Empty by default. */
  predicates: Record<string, boolean>;
  /** Total visits across all folded sessions. */
  seenCount: number;
  /** Up to EXAMPLE_CAP session refs that reached this state. Sorted. */
  examples: string[];
}

/** Overflow strategy once the hard state cap is exceeded. */
export type OverflowStrategy = 'coarsen' | 'stop';

export interface AbstractionConfig {
  /** Hard cap on distinct states. Enforced after every fold. Default 500. */
  maxStates: number;
  /**
   * What to do when the cap is exceeded:
   *  - 'coarsen': drop predicate bits, collapsing states to URL-template
   *    identity. If that still overflows, fall through to 'stop'.
   *  - 'stop': keep the most-visited `maxStates` states, drop the rest and
   *    any transition that references a dropped state, and set `truncated`.
   * Default 'coarsen'.
   */
  overflow: OverflowStrategy;
  /** Passed through to url-template inference. */
  minDistinctForParam: number;
}

export interface NavModel {
  version: 1;
  specId: string;
  targetKey: string;
  abstractionConfig: AbstractionConfig;
  states: ModelState[];
  transitions: ModelTransition[];
  /** Session refs folded in. Dedup key for idempotent merges. Sorted. */
  sessions: string[];
  /** The URL template set used for abstraction (serialized). */
  templates: ReturnType<TemplateSet['toJSON']>;
  /** Set when the cap forced states (and their edges) to be dropped. */
  truncated: boolean;
  /** Set when predicate bits were dropped to fit under the cap. */
  coarsened: boolean;
}

/** One observation trace to fold: a runner session's step stream (+ traffic). */
export interface SessionTrace {
  /** Stable identifier for this session (e.g. run id or artifact path). */
  ref: string;
  steps: StepObservation[];
  /** The session's captured traffic, for network-signature attribution. */
  traffic?: CapturedTraffic[];
}

/**
 * Opt-in coarse predicate extractor. Given a page context, returns a small
 * set of stable boolean affordance bits (e.g. {hasForm:true, isList:false}).
 * MUST be deterministic and should be derivable primarily from the URL — `ax`
 * and `title` may be absent (e.g. at a fresh entry point). Default: none.
 */
export type PredicateExtractor = (ctx: PredicateContext) => Record<string, boolean>;

export interface PredicateContext {
  url: string;
  urlTemplate: string;
  /** AX-snapshot digest, when known for this position. */
  ax?: string;
  title?: string;
  /** The action that arrived at this position, when known. */
  action?: string;
}

export interface LearnOptions {
  config?: Partial<AbstractionConfig>;
  predicates?: PredicateExtractor;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_ABSTRACTION_CONFIG: AbstractionConfig = {
  maxStates: 500,
  overflow: 'coarsen',
  minDistinctForParam: 8,
};

/** Max session refs retained per state's `examples`. */
const EXAMPLE_CAP = 5;

const NO_PREDICATES: PredicateExtractor = () => ({});

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex').slice(0, 12);
}

/** sortedPredicateBits: `key=1|0` pairs, keys sorted, ` `-joined. */
function encodePredicates(predicates: Record<string, boolean>): string {
  return Object.keys(predicates)
    .sort()
    .map((k) => `${k}=${predicates[k] ? '1' : '0'}`)
    .join(' ');
}

/** State id = hash(urlTemplate + sortedPredicateBits). */
export function stateId(urlTemplate: string, predicates: Record<string, boolean>): string {
  return shortHash(`${urlTemplate}${encodePredicates(predicates)}`);
}

/** Action key = hash(actionType + normalizedSelector). */
export function actionKey(action: string, normalizedSelector: string): string {
  return shortHash(`${action}${normalizedSelector}`);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function statusClass(status: number): StatusClass {
  if (status >= 100 && status < 200) return '1xx';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

/** Digest carried by an AX observation, when present. */
function axDigest(ax: AxObservation | undefined): string | undefined {
  if (!ax) return undefined;
  if ('digest' in ax) return ax.digest;
  return undefined;
}

/** Fallback template for a URL the template set could not match (defensive). */
function fallbackTemplate(url: string): string {
  try {
    const u = new URL(url, 'http://localhost');
    return u.pathname || '/';
  } catch {
    return url;
  }
}

function normalizeSelector(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// Learner
// ---------------------------------------------------------------------------

/** Collect every URL referenced by a session (steps + traffic) for templating. */
function collectUrls(sessions: SessionTrace[]): string[] {
  const urls: string[] = [];
  for (const s of sessions) {
    for (const step of s.steps) {
      if (step.urlBefore) urls.push(step.urlBefore);
      if (step.urlAfter) urls.push(step.urlAfter);
      const argUrl = step.args?.url;
      if (typeof argUrl === 'string') urls.push(argUrl);
    }
    for (const t of s.traffic ?? []) {
      if (t.url) urls.push(t.url);
    }
  }
  return urls;
}

/**
 * Fold a session set into a fresh navigation model. Pure and
 * order-independent: `learn(shuffle(S))` === `learn(S)`. Templates are
 * inferred once over the whole corpus, so state identity is stable across the
 * set.
 */
export function learn(
  specId: string,
  targetKey: string,
  sessions: SessionTrace[],
  opts: LearnOptions = {},
): NavModel {
  const config: AbstractionConfig = { ...DEFAULT_ABSTRACTION_CONFIG, ...opts.config };
  const extractor = opts.predicates ?? NO_PREDICATES;

  // Dedup sessions by ref up front so both template inference and folding see
  // exactly one copy of each session — re-learning the same set is idempotent.
  const byRef = new Map<string, SessionTrace>();
  for (const s of sessions) {
    if (!byRef.has(s.ref)) byRef.set(s.ref, s);
  }
  const deduped = [...byRef.values()];

  const templateSet = inferTemplates(collectUrls(deduped), {
    minDistinctForParam: config.minDistinctForParam,
  });

  const builder = new ModelBuilder(templateSet, extractor);
  for (const ref of [...byRef.keys()].sort()) {
    builder.foldSession(byRef.get(ref)!);
  }

  const model: NavModel = {
    version: 1,
    specId,
    targetKey,
    abstractionConfig: config,
    states: builder.states(),
    transitions: builder.transitions(),
    sessions: [...byRef.keys()].sort(),
    templates: templateSet.toJSON(),
    truncated: false,
    coarsened: false,
  };

  return enforceCap(model, config);
}

/**
 * Fold additional sessions into an existing model incrementally. Idempotent by
 * ref: sessions already present in `model.sessions` are skipped, so
 * `mergeSessions(learn(S), S)` === `learn(S)`.
 *
 * NOTE: this reuses the model's existing template set (extended only by adding
 * new source URLs and re-inferring), keeping existing state ids stable. When a
 * brand-new session shifts template inference (e.g. crossing the distinct-value
 * threshold), the incremental result may differ from a full `learn()` over the
 * union. Call `learn()` for a clean rebuild when that matters.
 */
export function mergeSessions(
  model: NavModel,
  sessions: SessionTrace[],
  opts: Omit<LearnOptions, 'config'> = {},
): NavModel {
  const config = model.abstractionConfig;
  const extractor = opts.predicates ?? NO_PREDICATES;

  const known = new Set(model.sessions);
  const fresh: SessionTrace[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (known.has(s.ref) || seen.has(s.ref)) continue;
    seen.add(s.ref);
    fresh.push(s);
  }
  if (fresh.length === 0) return model;

  // Re-infer templates over the prior corpus plus the new URLs.
  const priorTemplates = TemplateSet.fromJSON(model.templates);
  const newTemplates = inferTemplates(
    [...priorTemplates.toJSON().sourceUrls, ...collectUrls(fresh)],
    { minDistinctForParam: config.minDistinctForParam },
  );

  const builder = ModelBuilder.fromModel(model, newTemplates, extractor);
  for (const s of [...fresh].sort((a, b) => a.ref.localeCompare(b.ref))) {
    builder.foldSession(s);
  }

  const merged: NavModel = {
    ...model,
    states: builder.states(),
    transitions: builder.transitions(),
    sessions: [...model.sessions, ...fresh.map((s) => s.ref)].sort(),
    templates: newTemplates.toJSON(),
  };

  return enforceCap(merged, config);
}

// ---------------------------------------------------------------------------
// ModelBuilder — mutable accumulator behind the pure learn/merge functions.
// ---------------------------------------------------------------------------

class ModelBuilder {
  private stateMap = new Map<string, ModelState>();
  private exampleSets = new Map<string, Set<string>>();
  /** Transitions keyed by `${from}${actionKey}`. */
  private edgeMap = new Map<string, ModelTransition>();

  constructor(
    private templateSet: TemplateSet,
    private extractor: PredicateExtractor,
  ) {}

  static fromModel(
    model: NavModel,
    templateSet: TemplateSet,
    extractor: PredicateExtractor,
  ): ModelBuilder {
    const b = new ModelBuilder(templateSet, extractor);
    for (const st of model.states) {
      b.stateMap.set(st.id, {
        ...st,
        predicates: { ...st.predicates },
        examples: [...st.examples],
      });
      b.exampleSets.set(st.id, new Set(st.examples));
    }
    for (const tr of model.transitions) {
      b.edgeMap.set(edgeKey(tr.from, tr.actionKey), {
        from: tr.from,
        actionKey: tr.actionKey,
        recipe: { ...tr.recipe },
        targets: tr.targets.map((t) => ({
          ...t,
          networkSignature: t.networkSignature.map((n) => ({ ...n })),
        })),
      });
    }
    return b;
  }

  /** Fold one session's step stream into the accumulator. */
  foldSession(session: SessionTrace): void {
    const steps = [...session.steps].sort((a, b) => a.step - b.step);
    if (steps.length === 0) return;

    // Build the walk of visited state ids. Step 0 is always the initial goto
    // (see observation.ts): it has no meaningful predecessor, so it only seeds
    // the entry state (its landing) — no transition is emitted for it. Real
    // transitions start at step 1. Chaining reuses the previous step's
    // after-context as the next step's before-context so shared positions
    // collapse to one id.
    const walk: string[] = [];

    let prevCtx: PredicateContext = this.contextFor(
      steps[0].urlAfter,
      axDigest(steps[0].ax),
      steps[0].title,
      steps[0].action,
    );
    walk.push(this.ensureState(prevCtx));

    for (const step of steps.slice(1)) {
      const fromCtx =
        prevCtx.url === step.urlBefore
          ? prevCtx
          : this.contextFor(step.urlBefore, undefined, undefined, undefined);
      const fromId = this.ensureState(fromCtx);
      // The walk's tail must be the from-state of this step.
      if (walk[walk.length - 1] !== fromId) {
        // Discontinuity (a navigation the recorder didn't observe as a step):
        // still connect the chain so seenCount reflects the visit.
        walk.push(fromId);
      }

      const toCtx = this.contextFor(step.urlAfter, axDigest(step.ax), step.title, step.action);
      const toId = this.ensureState(toCtx);
      walk.push(toId);

      this.recordEdge(fromId, toId, step, session);
      prevCtx = toCtx;
    }

    // One visit per walk position; one example ref per state touched.
    for (const id of walk) {
      const st = this.stateMap.get(id)!;
      st.seenCount += 1;
    }
    for (const id of new Set(walk)) {
      this.addExample(id, session.ref);
    }
  }

  private contextFor(
    url: string,
    ax: string | undefined,
    title: string | undefined,
    action: string | undefined,
  ): PredicateContext {
    const matched = this.templateSet.match(url);
    const urlTemplate = matched?.template ?? fallbackTemplate(url);
    return { url, urlTemplate, ax, title, action };
  }

  /** Ensure a state exists for this context; returns its id. */
  private ensureState(ctx: PredicateContext): string {
    const predicates = this.extractor(ctx);
    const id = stateId(ctx.urlTemplate, predicates);
    if (!this.stateMap.has(id)) {
      this.stateMap.set(id, {
        id,
        urlTemplate: ctx.urlTemplate,
        predicates,
        seenCount: 0,
        examples: [],
      });
      this.exampleSets.set(id, new Set());
    }
    return id;
  }

  private addExample(id: string, ref: string): void {
    const set = this.exampleSets.get(id)!;
    if (set.has(ref) || set.size >= EXAMPLE_CAP) return;
    set.add(ref);
  }

  private recordEdge(
    fromId: string,
    toId: string,
    step: StepObservation,
    session: SessionTrace,
  ): void {
    const selector = normalizeSelector(step.args?.selector);
    const argUrl = step.args?.url;
    const normalizedForKey =
      selector || (typeof argUrl === 'string' ? this.templateOf(argUrl) : '');
    const key = edgeKey(fromId, actionKey(step.action, normalizedForKey));

    const recipe: Recipe = { action: step.action };
    if (selector) recipe.selector = selector;
    if (typeof argUrl === 'string') recipe.valueTemplate = this.templateOf(argUrl);

    let edge = this.edgeMap.get(key);
    if (!edge) {
      edge = {
        from: fromId,
        actionKey: actionKey(step.action, normalizedForKey),
        recipe,
        targets: [],
      };
      this.edgeMap.set(key, edge);
    }

    const signature = this.networkSignature(step, session);
    const lastSeen = step.tsEnd ?? 0;

    let target = edge.targets.find((t) => t.to === toId);
    if (!target) {
      target = { to: toId, count: 0, lastSeen: 0, networkSignature: [] };
      edge.targets.push(target);
    }
    target.count += 1;
    target.lastSeen = Math.max(target.lastSeen, lastSeen);
    target.networkSignature = mergeSignatures(target.networkSignature, signature);
  }

  private templateOf(url: string): string {
    return this.templateSet.match(url)?.template ?? fallbackTemplate(url);
  }

  private networkSignature(step: StepObservation, session: SessionTrace): NetworkSignatureEntry[] {
    const traffic = session.traffic;
    if (!traffic || !Array.isArray(step.trafficRange)) return [];
    const [start, end] = step.trafficRange;
    const slice = traffic.slice(Math.max(0, start), Math.max(0, end));
    const entries: NetworkSignatureEntry[] = [];
    for (const t of slice) {
      entries.push({
        method: t.method,
        urlTemplate: this.templateOf(t.url),
        statusClass: statusClass(t.status),
      });
    }
    return mergeSignatures([], entries);
  }

  states(): ModelState[] {
    // Flush example sets back into the state objects, sorted for stability.
    const out: ModelState[] = [];
    for (const st of this.stateMap.values()) {
      const set = this.exampleSets.get(st.id)!;
      out.push({ ...st, examples: [...set].sort() });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  transitions(): ModelTransition[] {
    const out: ModelTransition[] = [];
    for (const edge of this.edgeMap.values()) {
      out.push({
        ...edge,
        targets: [...edge.targets]
          .map((t) => ({ ...t, networkSignature: [...t.networkSignature] }))
          .sort((a, b) => a.to.localeCompare(b.to)),
      });
    }
    return out.sort(
      (a, b) => a.from.localeCompare(b.from) || a.actionKey.localeCompare(b.actionKey),
    );
  }
}

function edgeKey(from: string, action: string): string {
  return `${from}${action}`;
}

/** Union two network signatures, dedup by (method,urlTemplate,statusClass), sorted. */
function mergeSignatures(
  a: NetworkSignatureEntry[],
  b: NetworkSignatureEntry[],
): NetworkSignatureEntry[] {
  const map = new Map<string, NetworkSignatureEntry>();
  for (const e of [...a, ...b]) {
    map.set(`${e.method}${e.urlTemplate}${e.statusClass}`, e);
  }
  return [...map.values()].sort(
    (x, y) =>
      x.method.localeCompare(y.method) ||
      x.urlTemplate.localeCompare(y.urlTemplate) ||
      x.statusClass.localeCompare(y.statusClass),
  );
}

// ---------------------------------------------------------------------------
// State cap enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce the hard state cap. Pure — returns a new model. Applied after every
 * fold so a model never exceeds `config.maxStates`.
 *
 *  - Under cap: returned unchanged (flags cleared to reflect current state).
 *  - 'coarsen': collapse states to URL-template identity (drop predicate bits)
 *    and merge. If still over cap, fall through to truncation.
 *  - 'stop'/fallthrough: keep the `maxStates` most-visited states (tie-broken
 *    by id), drop the rest and any edge referencing a dropped state.
 */
export function enforceCap(model: NavModel, config: AbstractionConfig): NavModel {
  if (model.states.length <= config.maxStates) {
    return { ...model, truncated: false, coarsened: false };
  }

  let working = model;
  let coarsened = false;

  if (config.overflow === 'coarsen') {
    working = coarsenToTemplates(model);
    coarsened = true;
    if (working.states.length <= config.maxStates) {
      return { ...working, coarsened: true, truncated: false };
    }
  }

  const truncated = truncateToCap(working, config.maxStates);
  return { ...truncated, coarsened, truncated: true };
}

/** Re-key every state to `hash(urlTemplate + {})`, merging predicate variants. */
function coarsenToTemplates(model: NavModel): NavModel {
  const remap = new Map<string, string>();
  const merged = new Map<string, ModelState>();
  const examples = new Map<string, Set<string>>();

  for (const st of model.states) {
    const newId = stateId(st.urlTemplate, {});
    remap.set(st.id, newId);
    const exSet = examples.get(newId) ?? new Set<string>();
    for (const e of st.examples) {
      if (exSet.size < EXAMPLE_CAP) exSet.add(e);
    }
    examples.set(newId, exSet);
    const existing = merged.get(newId);
    if (existing) {
      existing.seenCount += st.seenCount;
    } else {
      merged.set(newId, {
        id: newId,
        urlTemplate: st.urlTemplate,
        predicates: {},
        seenCount: st.seenCount,
        examples: [],
      });
    }
  }

  const states = [...merged.values()]
    .map((s) => ({ ...s, examples: [...(examples.get(s.id) ?? new Set())].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const transitions = remapTransitions(model.transitions, remap);
  return { ...model, states, transitions };
}

/** Remap and merge transitions after a state-id remapping (coarsening). */
function remapTransitions(
  transitions: ModelTransition[],
  remap: Map<string, string>,
): ModelTransition[] {
  const edgeMap = new Map<string, ModelTransition>();
  for (const tr of transitions) {
    const from = remap.get(tr.from) ?? tr.from;
    const key = edgeKey(from, tr.actionKey);
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, actionKey: tr.actionKey, recipe: { ...tr.recipe }, targets: [] };
      edgeMap.set(key, edge);
    }
    for (const t of tr.targets) {
      const to = remap.get(t.to) ?? t.to;
      let target = edge.targets.find((x) => x.to === to);
      if (!target) {
        target = { to, count: 0, lastSeen: 0, networkSignature: [] };
        edge.targets.push(target);
      }
      target.count += t.count;
      target.lastSeen = Math.max(target.lastSeen, t.lastSeen);
      target.networkSignature = mergeSignatures(target.networkSignature, t.networkSignature);
    }
  }
  return [...edgeMap.values()]
    .map((e) => ({ ...e, targets: [...e.targets].sort((a, b) => a.to.localeCompare(b.to)) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.actionKey.localeCompare(b.actionKey));
}

/** Keep the top-`cap` states by seenCount (tie-break id); drop dangling edges. */
function truncateToCap(model: NavModel, cap: number): NavModel {
  const ranked = [...model.states].sort(
    (a, b) => b.seenCount - a.seenCount || a.id.localeCompare(b.id),
  );
  const kept = ranked.slice(0, cap);
  const keptIds = new Set(kept.map((s) => s.id));

  const states = [...kept].sort((a, b) => a.id.localeCompare(b.id));
  const transitions = model.transitions
    .filter((tr) => keptIds.has(tr.from))
    .map((tr) => ({ ...tr, targets: tr.targets.filter((t) => keptIds.has(t.to)) }))
    .filter((tr) => tr.targets.length > 0);

  return { ...model, states, transitions };
}

// ---------------------------------------------------------------------------
// Store — reviewable per-target artifact
// ---------------------------------------------------------------------------

/**
 * Resolve the model file path for a (spec, target) pair. Mirrors the memory
 * store's layout: `<spec_root>/.specify/model/<spec_id>/<target_key>.json`.
 */
export function modelPath(specRootDir: string, specId: string, targetKey: string): string {
  return path.join(
    specRootDir,
    '.specify',
    'model',
    safeSegment(specId),
    safeSegment(targetKey) + '.json',
  );
}

function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/** Load a model from disk, or null if absent/unreadable/wrong version. */
export function loadModel(filePath: string): NavModel | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && raw.version === 1 && Array.isArray(raw.states) && Array.isArray(raw.transitions)) {
      return raw as NavModel;
    }
  } catch {
    // Corrupt file: treat as absent so a rebuild can overwrite it cleanly.
  }
  return null;
}

/** Persist a model as a compact, git-diffable JSON artifact. */
export function saveModel(filePath: string, model: NavModel): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(model, null, 2) + '\n', 'utf-8');
}

export interface ModelStoreOptions {
  specRootDir: string;
  specId: string;
  targetKey: string;
}

/**
 * Thin persistence wrapper around learn/mergeSessions. Owns the on-disk
 * artifact path and offers a clean rebuild (`rebuild`) plus an idempotent
 * incremental fold (`update`).
 */
export class ModelStore {
  readonly filePath: string;

  constructor(private readonly options: ModelStoreOptions) {
    this.filePath = modelPath(options.specRootDir, options.specId, options.targetKey);
  }

  load(): NavModel | null {
    return loadModel(this.filePath);
  }

  /** Batch-learn from `sessions` and overwrite the artifact. */
  rebuild(sessions: SessionTrace[], opts: LearnOptions = {}): NavModel {
    const model = learn(this.options.specId, this.options.targetKey, sessions, opts);
    saveModel(this.filePath, model);
    return model;
  }

  /**
   * Fold `sessions` into the existing artifact (or start fresh if none),
   * idempotent by session ref, and persist. Use `rebuild` when a clean
   * re-template is desired.
   */
  update(sessions: SessionTrace[], opts: LearnOptions = {}): NavModel {
    const existing = this.load();
    const model = existing
      ? mergeSessions(existing, sessions, { predicates: opts.predicates })
      : learn(this.options.specId, this.options.targetKey, sessions, opts);
    saveModel(this.filePath, model);
    return model;
  }
}
