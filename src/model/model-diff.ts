/**
 * src/model/model-diff.ts — Navigation-model diff + stable-edge regression
 * alarms with live confirmation.
 *
 * The navigation-map learner (src/model/nav-model.ts) folds runner step traces
 * into a per-target model of states and (from, actionKey) → target transitions.
 * This module compares two such models — a BASELINE (the accumulated map,
 * folded over many sessions) against a CANDIDATE (a fresh session learned into
 * a model, or a newer accumulated map) — and reports *regressions* worth
 * alarming on.
 *
 * The problem this module exists to avoid: naive model diffing alarms on every
 * run. A/B tests, personalization, time-of-day content, and race-y ordering
 * all shift the map run-to-run without anything being broken. Three weeks of
 * that noise and the alarm channel is muted forever. So the policy here is
 * deliberately conservative on three axes:
 *
 *   1. STABILITY GATE. A missing/changed edge only counts if the baseline edge
 *      was *stable* — observed consistently across many of the folded sessions
 *      (see `isStableEdge`). A one-off edge disappearing is noise, not a
 *      regression. This is the change-point intuition applied to the baseline's
 *      accumulated evidence rather than to a single-run diff.
 *
 *   2. NONDETERMINISM EXEMPTION. An edge with two or more recurring targets
 *      (`isNondeterministic`) legitimately varies its destination — A/B split,
 *      personalization. Such edges are exempt from single-target-change alarms.
 *      They can still raise a disappearance alarm if the whole edge is gone.
 *
 *   3. VISIT GUARD. A disappeared edge is only a candidate regression when the
 *      candidate actually *visited* the edge's from-state. If the candidate run
 *      never went there, the edge is un-exercised, not gone — no alarm.
 *
 * And then, before any alarm actually fires, the affected transition is
 * REPLAYED on the live target: execute the recorded recipe from the current
 * state and observe where it lands. The alarm is emitted only if the replay
 * *confirms* the transition is gone or changed. If the replay still reaches the
 * baseline target, the model was merely stale while the app is fine — no alarm.
 * This is the one black-box-checking insight the epic kept: replay
 * model-derived counterexamples on the live target before alarming.
 *
 * This module is pure and deterministic except for the injected
 * `TransitionReplayer` (which drives the live target — its implementation lives
 * with the runner surface, not here). Diffing, stability classification, and
 * the regression policy are all pure functions over two models, so they are
 * fully unit-testable without a browser. Callers wire the replayer, an optional
 * LLM triage function, and the report sinks around this core.
 */

import type {
  NavModel,
  ModelState,
  ModelTransition,
  TransitionTarget,
  Recipe,
  NetworkSignatureEntry,
} from './nav-model.js';

// ---------------------------------------------------------------------------
// Diff types (pure key-set difference over states/transitions)
// ---------------------------------------------------------------------------

/** Identifies one edge across models: (from, actionKey) plus its recipe. */
export interface EdgeRef {
  from: string;
  actionKey: string;
  recipe: Recipe;
}

/** A `(from, actionKey)` present in both models but reaching a different target set. */
export interface TargetChange {
  from: string;
  actionKey: string;
  recipe: Recipe;
  baselineTargets: TransitionTarget[];
  candidateTargets: TransitionTarget[];
  /** to-state ids present in baseline but not candidate. Sorted. */
  removedTargets: string[];
  /** to-state ids present in candidate but not baseline. Sorted. */
  addedTargets: string[];
}

/**
 * Structural diff of two models: a key-set difference over states and edges,
 * plus same-key/different-target detection. This is descriptive only — it does
 * NOT apply the stability gate or the nondeterminism exemption. Use
 * `detectRegressions` / `detectRegressionAlarms` for the alarm policy.
 */
export interface ModelDiff {
  states: {
    /** state ids only in candidate. Sorted. */
    added: string[];
    /** state ids only in baseline. Sorted. */
    removed: string[];
    /** state ids in both. Sorted. */
    common: string[];
  };
  transitions: {
    /** edges (from, actionKey) only in candidate. */
    added: EdgeRef[];
    /** edges (from, actionKey) only in baseline. */
    removed: EdgeRef[];
    /** edges present in both whose reachable target set differs. */
    targetChanged: TargetChange[];
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StabilityConfig {
  /**
   * Minimum total observations of an edge (summed over its targets) before it
   * can be considered stable. A handful of observations is not enough evidence
   * that an edge is load-bearing. Default 3.
   */
  minObservations: number;
  /**
   * Minimum ratio of edge observations to baseline session count for the edge
   * to count as stable — "seen in most sessions". Because a single session can
   * observe the same edge more than once, this ratio can exceed 1; that only
   * makes an edge more stable. Default 0.6.
   */
  minSessionFraction: number;
  /**
   * A target counts as *recurring* (and thus as evidence of nondeterminism)
   * when its share of the edge's observations is at least this fraction. Rare
   * one-off targets below the floor are treated as noise, not as a second
   * legitimate destination. Default 0.2.
   */
  nondeterministicFloor: number;
}

export const DEFAULT_STABILITY_CONFIG: StabilityConfig = {
  minObservations: 3,
  minSessionFraction: 0.6,
  nondeterministicFloor: 0.2,
};

// ---------------------------------------------------------------------------
// Small map/index helpers
// ---------------------------------------------------------------------------

function edgeMapKey(from: string, actionKey: string): string {
  return `${from}|${actionKey}`;
}

function indexStates(model: NavModel): Map<string, ModelState> {
  const m = new Map<string, ModelState>();
  for (const s of model.states) m.set(s.id, s);
  return m;
}

function indexEdges(model: NavModel): Map<string, ModelTransition> {
  const m = new Map<string, ModelTransition>();
  for (const t of model.transitions) m.set(edgeMapKey(t.from, t.actionKey), t);
  return m;
}

function targetIds(targets: TransitionTarget[]): string[] {
  return targets.map((t) => t.to).sort();
}

function toRef(edge: ModelTransition): EdgeRef {
  return { from: edge.from, actionKey: edge.actionKey, recipe: edge.recipe };
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

/**
 * Pure structural diff of two models. Key-set difference over state ids and
 * edge keys, plus same-key/different-target detection. Deterministic: all
 * output arrays are sorted by stable keys.
 */
export function diffModels(baseline: NavModel, candidate: NavModel): ModelDiff {
  const baseStates = new Set(baseline.states.map((s) => s.id));
  const candStates = new Set(candidate.states.map((s) => s.id));

  const addedStates: string[] = [];
  const removedStates: string[] = [];
  const commonStates: string[] = [];
  for (const id of baseStates) {
    (candStates.has(id) ? commonStates : removedStates).push(id);
  }
  for (const id of candStates) {
    if (!baseStates.has(id)) addedStates.push(id);
  }

  const baseEdges = indexEdges(baseline);
  const candEdges = indexEdges(candidate);

  const added: EdgeRef[] = [];
  const removed: EdgeRef[] = [];
  const targetChanged: TargetChange[] = [];

  for (const [key, edge] of baseEdges) {
    const other = candEdges.get(key);
    if (!other) {
      removed.push(toRef(edge));
      continue;
    }
    const baseIds = targetIds(edge.targets);
    const candIds = targetIds(other.targets);
    if (baseIds.join(',') !== candIds.join(',')) {
      const baseSet = new Set(baseIds);
      const candSet = new Set(candIds);
      targetChanged.push({
        from: edge.from,
        actionKey: edge.actionKey,
        recipe: edge.recipe,
        baselineTargets: edge.targets,
        candidateTargets: other.targets,
        removedTargets: baseIds.filter((id) => !candSet.has(id)),
        addedTargets: candIds.filter((id) => !baseSet.has(id)),
      });
    }
  }
  for (const [key, edge] of candEdges) {
    if (!baseEdges.has(key)) added.push(toRef(edge));
  }

  const byFromAction = (a: EdgeRef, b: EdgeRef) =>
    a.from.localeCompare(b.from) || a.actionKey.localeCompare(b.actionKey);

  return {
    states: {
      added: addedStates.sort(),
      removed: removedStates.sort(),
      common: commonStates.sort(),
    },
    transitions: {
      added: added.sort(byFromAction),
      removed: removed.sort(byFromAction),
      targetChanged: targetChanged.sort(
        (a, b) => a.from.localeCompare(b.from) || a.actionKey.localeCompare(b.actionKey),
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Stability + nondeterminism classification
// ---------------------------------------------------------------------------

/** Total observations of an edge = sum of its targets' counts. */
export function edgeObservationCount(edge: ModelTransition): number {
  return edge.targets.reduce((n, t) => n + t.count, 0);
}

/**
 * The edge's recurring targets: those whose share of the edge's observations
 * meets `nondeterministicFloor`. Sorted by count descending, then to-id. An
 * edge with a single recurring target is deterministic; two or more make it
 * nondeterministic. Rare below-floor targets are dropped as noise.
 */
export function recurringTargets(
  edge: ModelTransition,
  cfg: StabilityConfig = DEFAULT_STABILITY_CONFIG,
): TransitionTarget[] {
  // Schema forbids empty target lists, but defensive code must not crash on
  // one (maxByCount below would reduce over an empty array).
  if (edge.targets.length === 0) return [];
  const total = edgeObservationCount(edge);
  if (total === 0) return [];
  const kept = edge.targets.filter((t) => t.count / total >= cfg.nondeterministicFloor);
  // Defensive: if the floor filtered everything (all targets equally tiny),
  // fall back to the single most-seen target so the edge still has a primary.
  const chosen = kept.length > 0 ? kept : [maxByCount(edge.targets)];
  return [...chosen].sort((a, b) => b.count - a.count || a.to.localeCompare(b.to));
}

function maxByCount(targets: TransitionTarget[]): TransitionTarget {
  return targets.reduce((best, t) =>
    t.count > best.count || (t.count === best.count && t.to < best.to) ? t : best,
  );
}

/** An edge is nondeterministic when it has two or more recurring targets. */
export function isNondeterministic(
  edge: ModelTransition,
  cfg: StabilityConfig = DEFAULT_STABILITY_CONFIG,
): boolean {
  return recurringTargets(edge, cfg).length >= 2;
}

/**
 * An edge is stable when the baseline accumulated enough consistent evidence
 * for it: at least `minObservations` total observations AND an
 * observation-to-session ratio of at least `minSessionFraction`. `sessionCount`
 * is the number of sessions folded into the baseline (`baseline.sessions.length`).
 */
export function isStableEdge(
  edge: ModelTransition,
  sessionCount: number,
  cfg: StabilityConfig = DEFAULT_STABILITY_CONFIG,
): boolean {
  const observations = edgeObservationCount(edge);
  if (observations < cfg.minObservations) return false;
  if (sessionCount <= 0) return false;
  return observations / sessionCount >= cfg.minSessionFraction;
}

/** Stability metrics for one edge, for evidence/reporting. */
export interface EdgeStability {
  observations: number;
  sessionCount: number;
  sessionFraction: number;
  stable: boolean;
  nondeterministic: boolean;
}

export function edgeStability(
  edge: ModelTransition,
  sessionCount: number,
  cfg: StabilityConfig = DEFAULT_STABILITY_CONFIG,
): EdgeStability {
  const observations = edgeObservationCount(edge);
  return {
    observations,
    sessionCount,
    sessionFraction: sessionCount > 0 ? observations / sessionCount : 0,
    stable: isStableEdge(edge, sessionCount, cfg),
    nondeterministic: isNondeterministic(edge, cfg),
  };
}

// ---------------------------------------------------------------------------
// Regression detection (policy over the structural diff)
// ---------------------------------------------------------------------------

export type RegressionKind = 'edge_disappeared' | 'edge_target_changed';

/**
 * A candidate regression: a stable baseline edge that the candidate no longer
 * reproduces. "Candidate" here means *pre-confirmation* — it has passed the
 * structural + stability + visit gates but has NOT yet been replayed on the
 * live target. Only confirmed regressions become alarms.
 */
export interface CandidateRegression {
  kind: RegressionKind;
  edge: EdgeRef;
  /** Baseline from-state (carries urlTemplate/predicates for the replay + evidence). */
  fromState: ModelState;
  /** Baseline stability metrics for the edge. */
  stability: EdgeStability;
  /** Baseline recurring (expected) targets — the destinations the edge should still reach. */
  baselineRecurringTargets: TransitionTarget[];
  /** All baseline targets, for before-evidence. */
  baselineTargets: TransitionTarget[];
  /** Candidate targets for the same edge (empty when the edge disappeared). */
  candidateTargets: TransitionTarget[];
}

/**
 * Apply the alarm policy to two models and return candidate regressions
 * (pre-confirmation). Pure and deterministic.
 *
 * Policy, per stable baseline edge whose from-state the candidate visited:
 *   - Edge absent in candidate            → `edge_disappeared`.
 *   - Edge present, deterministic, and its recurring baseline target is not
 *     among the candidate's targets       → `edge_target_changed`.
 *   - Edge present and nondeterministic    → exempt from target-change alarms.
 *
 * Accepted conservatism: a nondeterministic edge that loses ONE of its
 * recurring targets does not alarm — only its full disappearance does. A
 * variant vanishing is indistinguishable from the A/B split simply not being
 * sampled this run, so alarming on it would reintroduce exactly the flakiness
 * noise this policy exists to suppress. This is an intentional trade-off:
 * partial-variant regressions are deferred until the whole edge breaks.
 *
 * A baseline edge whose from-state is not in the candidate's states is skipped:
 * the candidate simply never exercised that area, so absence proves nothing.
 */
export function detectRegressions(
  baseline: NavModel,
  candidate: NavModel,
  cfg: StabilityConfig = DEFAULT_STABILITY_CONFIG,
): CandidateRegression[] {
  const baseStates = indexStates(baseline);
  const candStates = indexStates(candidate);
  const candEdges = indexEdges(candidate);
  const sessionCount = baseline.sessions.length;

  const out: CandidateRegression[] = [];

  for (const edge of baseline.transitions) {
    const stability = edgeStability(edge, sessionCount, cfg);
    if (!stability.stable) continue;

    const fromState = baseStates.get(edge.from);
    if (!fromState) continue; // baseline is internally inconsistent; skip defensively.

    // Visit guard: the candidate must have reached the from-state, else the
    // edge is un-exercised (not gone) and we cannot conclude anything.
    if (!candStates.has(edge.from)) continue;

    const recurring = recurringTargets(edge, cfg);
    const candEdge = candEdges.get(edgeMapKey(edge.from, edge.actionKey));

    if (!candEdge) {
      out.push({
        kind: 'edge_disappeared',
        edge: toRef(edge),
        fromState,
        stability,
        baselineRecurringTargets: recurring,
        baselineTargets: edge.targets,
        candidateTargets: [],
      });
      continue;
    }

    // Nondeterministic edges legitimately vary their destination — exempt from
    // single-target-change alarms. (A full disappearance is handled above.)
    if (stability.nondeterministic) continue;

    // Deterministic edge: the single recurring baseline target must still be
    // reachable in the candidate. If not, the destination changed.
    const candTargetIds = new Set(candEdge.targets.map((t) => t.to));
    const stillReaches = recurring.some((t) => candTargetIds.has(t.to));
    if (!stillReaches) {
      out.push({
        kind: 'edge_target_changed',
        edge: toRef(edge),
        fromState,
        stability,
        baselineRecurringTargets: recurring,
        baselineTargets: edge.targets,
        candidateTargets: candEdge.targets,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Live confirmation (replay)
// ---------------------------------------------------------------------------

/** One expected destination for a replay: the baseline target we hope still holds. */
export interface ReplayExpectedTarget {
  to: string;
  urlTemplate?: string;
}

/** A request to replay one recorded transition on the live target. */
export interface ReplayRequest {
  edge: EdgeRef;
  /** URL template of the from-state — where the replay should start. */
  fromUrlTemplate: string;
  /** Baseline recurring targets the transition is expected to still reach. */
  expectedTargets: ReplayExpectedTarget[];
}

/** What a replay observed on the live target. */
export interface ReplayObservation {
  /** True iff executing the recipe from the from-state produced a transition at all. */
  reached: boolean;
  /** State id landed on, when the caller could map it to a model state. */
  toState?: string;
  /** URL template landed on, when derivable. */
  toUrlTemplate?: string;
  /** AX-snapshot digest at the landing, for before/after evidence. */
  axDigest?: string;
  /** Network signature observed while taking the replayed arc. */
  networkSignature?: NetworkSignatureEntry[];
  /** Populated when the replay could not run (from-state unreachable, recipe stale). */
  error?: string;
}

/**
 * Drives the live target to replay a recorded transition. Implemented against
 * the runner/browser surface elsewhere; this module only consumes the
 * interface so the policy stays pure and testable.
 */
export interface TransitionReplayer {
  replay(req: ReplayRequest): Promise<ReplayObservation>;
}

/** The verdict of replaying a candidate regression on the live target. */
export interface ReplayConfirmation {
  /** True ⇒ the regression is real and should alarm. */
  confirmed: boolean;
  /** Final kind after replay — a disappeared edge that now reaches a *new* state reclassifies to changed. */
  kind: RegressionKind;
  observed: ReplayObservation;
  /** Human-readable reason, suitable for triage/report copy. */
  reason: string;
}

function replayRequestFor(reg: CandidateRegression): ReplayRequest {
  return {
    edge: reg.edge,
    fromUrlTemplate: reg.fromState.urlTemplate,
    expectedTargets: reg.baselineRecurringTargets.map((t) => ({ to: t.to })),
  };
}

/**
 * Decide whether a replay observation confirms a candidate regression.
 *
 * Destination-first rule: when the replay REACHED a destination, that
 * destination decides the verdict — a non-fatal `error` string alongside
 * `reached: true` (e.g. a console error noted mid-replay) never overrides
 * where the transition actually landed:
 *
 *   - Reached an expected baseline target   → NOT confirmed. The model was
 *     stale; the app is fine. (This is the false-alarm guard.)
 *   - Reached a different destination       → confirmed, changed.
 *
 * When the replay did NOT reach a destination, the `error` field decides:
 *
 *   - No error (the recipe ran but produced no transition)
 *                                           → confirmed, disappeared.
 *   - Error set (replayer failure: from-state unreachable, timeout, stale
 *     recipe infrastructure) → INCONCLUSIVE, NOT confirmed. A broken replay
 *     proves nothing about the app — treating it as confirmation would turn
 *     every replayer outage into an alarm storm, exactly the noise this
 *     module exists to prevent.
 *
 * `expectedTemplates` lets the caller match on URL template when the replayer
 * could not resolve a concrete state id.
 */
export function confirmRegression(
  reg: CandidateRegression,
  obs: ReplayObservation,
  expectedTemplates: Set<string> = new Set(),
): ReplayConfirmation {
  const expectedIds = new Set(reg.baselineRecurringTargets.map((t) => t.to));

  if (obs.reached) {
    const reachedExpected =
      (obs.toState !== undefined && expectedIds.has(obs.toState)) ||
      (obs.toUrlTemplate !== undefined && expectedTemplates.has(obs.toUrlTemplate));
    if (reachedExpected) {
      return {
        confirmed: false,
        kind: reg.kind,
        observed: obs,
        reason:
          'Live replay still reached the expected target — the navigation map was stale, not the app. No alarm.',
      };
    }
    // Fall through to the changed-destination verdict below.
  } else if (obs.error) {
    // Replay infrastructure failed — inconclusive, never a confirmation.
    return {
      confirmed: false,
      kind: reg.kind,
      observed: obs,
      reason: `Live replay could not run (${obs.error}) — inconclusive, no alarm.`,
    };
  } else {
    return {
      confirmed: true,
      kind: 'edge_disappeared',
      observed: obs,
      reason: 'Live replay of the recorded transition reached no state — the transition is gone.',
    };
  }

  // Reached a concrete but unexpected destination.
  const dest = obs.toState ?? obs.toUrlTemplate ?? 'an unexpected state';
  return {
    confirmed: true,
    kind: 'edge_target_changed',
    observed: obs,
    reason: `Live replay now reaches ${dest} instead of the expected target — the transition changed.`,
  };
}

// ---------------------------------------------------------------------------
// Evidence + alarms
// ---------------------------------------------------------------------------

/** Before/after view of one edge target, for attaching to an alarm. */
export interface EdgeTargetEvidence {
  to: string;
  urlTemplate?: string;
  count?: number;
  networkSignature: NetworkSignatureEntry[];
}

/** Structured evidence bundle attached to every alarm. */
export interface AlarmEvidence {
  before: {
    recipe: Recipe;
    fromUrlTemplate: string;
    targets: EdgeTargetEvidence[];
  };
  after: {
    targets: EdgeTargetEvidence[];
  };
  /** The live-replay observation, present when a replayer confirmed the alarm. */
  replay?: ReplayObservation;
}

/** A confirmed (or, without a replayer, unconfirmed) regression to surface. */
export interface RegressionAlarm {
  kind: RegressionKind;
  edge: EdgeRef;
  fromState: ModelState;
  stability: EdgeStability;
  baselineTargets: TransitionTarget[];
  candidateTargets: TransitionTarget[];
  /** True when the baseline edge was nondeterministic (only disappearances reach here). */
  nondeterministic: boolean;
  /** Present iff a replayer ran. Absent alarms are UNCONFIRMED — see detectRegressionAlarms. */
  confirmation?: ReplayConfirmation;
  evidence: AlarmEvidence;
}

function targetEvidence(
  targets: TransitionTarget[],
  statesById: Map<string, ModelState>,
): EdgeTargetEvidence[] {
  return targets.map((t) => ({
    to: t.to,
    urlTemplate: statesById.get(t.to)?.urlTemplate,
    count: t.count,
    networkSignature: t.networkSignature,
  }));
}

function buildEvidence(
  reg: CandidateRegression,
  baseStates: Map<string, ModelState>,
  candStates: Map<string, ModelState>,
  replay?: ReplayObservation,
): AlarmEvidence {
  return {
    before: {
      recipe: reg.edge.recipe,
      fromUrlTemplate: reg.fromState.urlTemplate,
      targets: targetEvidence(reg.baselineTargets, baseStates),
    },
    after: {
      targets: targetEvidence(reg.candidateTargets, candStates),
    },
    ...(replay ? { replay } : {}),
  };
}

export interface DiffAlarmOptions {
  stability?: Partial<StabilityConfig>;
  /**
   * Drives live replay confirmation. When provided, only regressions the
   * replay confirms become alarms (the recommended production path). When
   * omitted, all candidate regressions are returned UNCONFIRMED (no
   * `confirmation` field) — a fast path for callers that will confirm later or
   * only want the structural signal. Production MUST supply a replayer.
   */
  replayer?: TransitionReplayer;
}

/**
 * End-to-end: diff two models, apply the stable-edge regression policy, and —
 * when a replayer is supplied — confirm each candidate on the live target,
 * keeping only those the replay confirms. Every returned alarm carries a
 * before/after evidence bundle (recipes, network signatures, and the replay
 * observation) ready for LLM triage and the report sinks.
 */
export async function detectRegressionAlarms(
  baseline: NavModel,
  candidate: NavModel,
  opts: DiffAlarmOptions = {},
): Promise<RegressionAlarm[]> {
  const cfg: StabilityConfig = { ...DEFAULT_STABILITY_CONFIG, ...opts.stability };
  const baseStates = indexStates(baseline);
  const candStates = indexStates(candidate);
  const regressions = detectRegressions(baseline, candidate, cfg);

  const alarms: RegressionAlarm[] = [];
  for (const reg of regressions) {
    if (!opts.replayer) {
      // Unconfirmed fast path — no live check performed.
      alarms.push({
        kind: reg.kind,
        edge: reg.edge,
        fromState: reg.fromState,
        stability: reg.stability,
        baselineTargets: reg.baselineTargets,
        candidateTargets: reg.candidateTargets,
        nondeterministic: reg.stability.nondeterministic,
        evidence: buildEvidence(reg, baseStates, candStates),
      });
      continue;
    }

    const expectedTemplates = new Set(
      reg.baselineRecurringTargets
        .map((t) => baseStates.get(t.to)?.urlTemplate)
        .filter((u): u is string => typeof u === 'string'),
    );
    const obs = await opts.replayer.replay(replayRequestFor(reg));
    const confirmation = confirmRegression(reg, obs, expectedTemplates);
    if (!confirmation.confirmed) continue; // stale model, app fine — no alarm.

    alarms.push({
      kind: confirmation.kind,
      edge: reg.edge,
      fromState: reg.fromState,
      stability: reg.stability,
      baselineTargets: reg.baselineTargets,
      candidateTargets: reg.candidateTargets,
      nondeterministic: reg.stability.nondeterministic,
      confirmation,
      evidence: buildEvidence(reg, baseStates, candStates, obs),
    });
  }

  return alarms;
}

// ---------------------------------------------------------------------------
// Triage + reporting payloads
// ---------------------------------------------------------------------------

/**
 * A flat, JSON-serializable record for one alarm, shaped for the report sinks
 * (src/agent/report-sink.ts) and the review webapp. Deliberately plain data —
 * no functions, no model object graphs — so it survives the file/slack/platform
 * round-trips unchanged.
 */
export interface RegressionAlarmRecord {
  kind: RegressionKind;
  confirmed: boolean;
  from: string;
  fromUrlTemplate: string;
  action: string;
  selector?: string;
  /** Baseline destinations (url templates) the edge used to reach. */
  expectedTargets: string[];
  /** Candidate destinations (url templates), empty when the edge disappeared. */
  observedTargets: string[];
  observations: number;
  sessionFraction: number;
  nondeterministic: boolean;
  reason?: string;
  /** Where the live replay actually landed, when a replay ran. */
  replayLanded?: string;
}

function urlTemplatesOf(targets: EdgeTargetEvidence[]): string[] {
  return targets
    .map((t) => t.urlTemplate ?? t.to)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

/** Flatten one alarm into a report/triage record. */
export function toAlarmRecord(alarm: RegressionAlarm): RegressionAlarmRecord {
  const replay = alarm.confirmation?.observed;
  return {
    kind: alarm.kind,
    confirmed: alarm.confirmation?.confirmed ?? false,
    from: alarm.edge.from,
    fromUrlTemplate: alarm.fromState.urlTemplate,
    action: alarm.edge.recipe.action,
    ...(alarm.edge.recipe.selector ? { selector: alarm.edge.recipe.selector } : {}),
    expectedTargets: urlTemplatesOf(alarm.evidence.before.targets),
    observedTargets: urlTemplatesOf(alarm.evidence.after.targets),
    observations: alarm.stability.observations,
    sessionFraction: alarm.stability.sessionFraction,
    nondeterministic: alarm.nondeterministic,
    ...(alarm.confirmation ? { reason: alarm.confirmation.reason } : {}),
    ...(replay
      ? {
          replayLanded:
            replay.toUrlTemplate ?? replay.toState ?? (replay.reached ? 'unknown' : 'nowhere'),
        }
      : {}),
  };
}

/**
 * A triage verdict for one alarm, produced by an injected LLM triage function.
 * Kept minimal: the classifier decides severity and whether to surface.
 */
export interface TriageVerdict {
  /** Whether this alarm should be surfaced to humans / the platform. */
  surface: boolean;
  severity: 'low' | 'medium' | 'high';
  /** One-line triage note. */
  note: string;
}

export interface TriagedAlarm {
  alarm: RegressionAlarm;
  record: RegressionAlarmRecord;
  verdict?: TriageVerdict;
}

/** An injected triage function — typically an LLM call with the record attached. */
export type TriageFn = (record: RegressionAlarmRecord) => Promise<TriageVerdict>;

/**
 * Route confirmed alarms through triage (when a triage function is supplied),
 * attaching each alarm's flat record and the verdict. Without a triage function
 * the records pass through un-triaged, ready to be surfaced as-is.
 */
export async function triageAlarms(
  alarms: RegressionAlarm[],
  triage?: TriageFn,
): Promise<TriagedAlarm[]> {
  const out: TriagedAlarm[] = [];
  for (const alarm of alarms) {
    const record = toAlarmRecord(alarm);
    const verdict = triage ? await triage(record) : undefined;
    out.push({ alarm, record, ...(verdict ? { verdict } : {}) });
  }
  return out;
}
