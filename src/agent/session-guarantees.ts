/**
 * src/agent/session-guarantees.ts — Session-guarantee checker + anomaly
 * reporting (epic SP-jdb, Tier 4). The deterministic verdict layer over the
 * probe op log produced by src/agent/probe-workload.ts.
 *
 * WHY
 * ----------------------------------------------------------------------------
 * A probe workload issues its own marker-tagged CRUD operations and records,
 * per op, exactly what was sent, what came back, and whether the op succeeded,
 * failed, or is INDETERMINATE (see probe-workload.ts). This module is the pure,
 * fully-deterministic consumer of that log: it checks the session guarantees a
 * black-box tool CAN soundly assert from a designed, self-authored workload —
 * and no more.
 *
 * This is ACTIVE, marker-tagged checking, not passive history inspection: every
 * verdict is anchored on a marker THIS tool wrote and then looked for. A read
 * "reflects a write" iff the marker written by that write is present in the
 * read's response body.
 *
 * THE FOUR GUARANTEES
 * ----------------------------------------------------------------------------
 *  1. read-your-writes: after an `ok` create/update carrying marker M, the next
 *     `ok` read for that entity must contain M.
 *  2. monotonic-reads: once M has been observed present in an `ok` read/list, a
 *     later `ok` read/list must not lose it — until an intervening delete or an
 *     overwriting update legitimately removes it.
 *  3. no-resurrection: after an `ok` delete, no later `ok` read/list may contain
 *     the deleted marker.
 *  4. create-appears-in-list: after an `ok` create carrying M, a subsequent
 *     `ok` list must contain M — subject to a configurable eventual-consistency
 *     tolerance window (a list that misses M within `toleranceMs` of the write
 *     is NOT an anomaly; it is reported clean with the tolerance noted).
 *
 * HONEST THREE-OUTCOME DISCIPLINE (the whole point — do not "simplify")
 * ----------------------------------------------------------------------------
 * An INDETERMINATE op (a timed-out request that may or may not have applied)
 * NEVER produces a false anomaly. It is treated as possibly-applied: it widens
 * the set of acceptable observations, so any check that depends on it is marked
 * `inconclusive`, never `violated`. Likewise a non-2xx (`fail`) observation
 * yields no marker evidence and is inconclusive rather than a violation. Only a
 * definite `ok` observation that contradicts a definite `ok` write is an
 * anomaly. Under-claiming is acceptable; a false anomaly is not.
 *
 * EXPLICIT NON-CLAIMS
 * ----------------------------------------------------------------------------
 * No isolation-level inference. Session guarantees are per-session checkable;
 * isolation anomaly detection requires designed multi-session histories, which
 * are out of scope for this epic. `report.nonClaims` states this and the other
 * deliberate limits so a reader never over-reads a clean bill.
 */

import type { ProbeOpRecord } from './probe-workload.js';
import type {
  BehaviorResult,
  GuaranteeCheck,
  GuaranteeKind,
  GuaranteeVerdict,
  GuaranteeWitnessOp,
} from '../spec/types.js';

export type { GuaranteeCheck, GuaranteeKind, GuaranteeVerdict, GuaranteeWitnessOp };

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface GuaranteeCounts {
  holds: number;
  violated: number;
  inconclusive: number;
}

export interface SessionGuaranteeReport {
  /** Every guarantee check produced, in the order the deciding op was issued. */
  checks: GuaranteeCheck[];
  /** The subset of `checks` whose verdict is `violated` — the anomalies. */
  anomalies: GuaranteeCheck[];
  summary: {
    total: number;
    holds: number;
    violated: number;
    inconclusive: number;
    /** Counts broken out per guarantee kind. */
    byGuarantee: Record<GuaranteeKind, GuaranteeCounts>;
  };
  /** Deliberate limits of this checker — what a clean report does NOT assert. */
  nonClaims: string[];
}

export interface CheckOptions {
  /**
   * Eventual-consistency tolerance for `create-appears-in-list` (and the list
   * side of `monotonic-reads`): a list that misses a marker within this many
   * milliseconds of the establishing write's completion is reported clean with
   * the tolerance noted, not as an anomaly. Default 0 (strict — any miss past
   * the write is a violation). Tolerance is target-specific engineering: set it
   * explicitly per target where a store is known to be eventually consistent.
   */
  toleranceMs?: number;
}

// ---------------------------------------------------------------------------
// Marker observation
// ---------------------------------------------------------------------------

/**
 * True iff `marker` is present anywhere in an op's response body. Markers are
 * unique, prefixed UUID tokens (see MARKER_PREFIX in probe-workload.ts), so a
 * substring match over the serialized body is both sound (no collisions) and
 * robust to whatever nesting/wrapping the target uses for reads and lists.
 */
export function bodyContainsMarker(body: unknown, marker: string): boolean {
  if (body === undefined || body === null) return false;
  let serialized: string;
  try {
    serialized = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    serialized = String(body);
  }
  return serialized.includes(marker);
}

// ---------------------------------------------------------------------------
// Witness helpers
// ---------------------------------------------------------------------------

function witnessOf(op: ProbeOpRecord): GuaranteeWitnessOp {
  return {
    opId: op.opId,
    type: op.type,
    outcome: op.outcome,
    marker: op.marker,
    ts: op.completeTs,
  };
}

// ---------------------------------------------------------------------------
// Per-entity state machine
// ---------------------------------------------------------------------------

/** The last `ok` write and the marker it established for an entity. */
interface Established {
  marker: string;
  writeOp: ProbeOpRecord;
  kind: 'create' | 'update';
  /** Set once the marker has been positively observed present in an `ok` read/list. */
  observed: boolean;
}

interface EntityState {
  /** Last `ok` create/update's marker, or null when none holds (start / after delete). */
  established: Established | null;
  /** An `ok` delete with no `ok` write after it — the deleted marker for resurrection checks. */
  deletedMarker: string | null;
  deleteOp: ProbeOpRecord | null;
  /** An indeterminate create/update since the last definite state: current marker is ambiguous. */
  ambiguousWrite: ProbeOpRecord | null;
  /** An indeterminate delete: the entity may or may not be gone. */
  ambiguousDelete: ProbeOpRecord | null;
}

function initialState(): EntityState {
  return {
    established: null,
    deletedMarker: null,
    deleteOp: null,
    ambiguousWrite: null,
    ambiguousDelete: null,
  };
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

/**
 * Deterministically check the session guarantees over a probe op log. Pure: the
 * input ops are never mutated. Ops are grouped by entity (each entity's CRUD
 * sequence is one session) and walked in issue order (`opId`), which is the
 * order the workload generator emits.
 */
export function checkSessionGuarantees(
  ops: readonly ProbeOpRecord[],
  opts: CheckOptions = {},
): SessionGuaranteeReport {
  const toleranceMs = opts.toleranceMs ?? 0;
  const checks: GuaranteeCheck[] = [];

  // Group by entity, preserving issue order within each group.
  const byEntity = new Map<string, ProbeOpRecord[]>();
  const sorted = [...ops].sort((a, b) => a.opId.localeCompare(b.opId));
  for (const op of sorted) {
    const list = byEntity.get(op.entity) ?? [];
    list.push(op);
    byEntity.set(op.entity, list);
  }

  for (const [entity, entityOps] of byEntity) {
    const state = initialState();
    for (const op of entityOps) {
      switch (op.type) {
        case 'create':
        case 'update':
          applyWrite(state, op);
          break;
        case 'delete':
          applyDelete(state, op);
          break;
        case 'read':
          checkObservation(state, op, entity, 'read', toleranceMs, checks);
          break;
        case 'list':
          checkObservation(state, op, entity, 'list', toleranceMs, checks);
          break;
      }
    }
  }

  return buildReport(checks, toleranceMs);
}

/** Fold a create/update op into entity state. */
function applyWrite(state: EntityState, op: ProbeOpRecord): void {
  if (op.outcome === 'ok') {
    if (op.marker !== null) {
      state.established = {
        marker: op.marker,
        writeOp: op,
        kind: op.type as 'create' | 'update',
        observed: false,
      };
      // An `ok` write resolves any prior ambiguity and un-deletes the entity.
    }
    state.ambiguousWrite = null;
    state.ambiguousDelete = null;
    state.deletedMarker = null;
    state.deleteOp = null;
  } else if (op.outcome === 'indeterminate') {
    // Possibly-applied: the current marker is now ambiguous.
    state.ambiguousWrite = op;
  }
  // `fail`: a definite non-2xx / pre-flight error means the write did not
  // apply — no state change.
}

/** Fold a delete op into entity state. */
function applyDelete(state: EntityState, op: ProbeOpRecord): void {
  if (op.outcome === 'ok') {
    state.deletedMarker = state.established?.marker ?? op.marker;
    state.deleteOp = op;
    state.established = null;
    state.ambiguousWrite = null;
    state.ambiguousDelete = null;
  } else if (op.outcome === 'indeterminate') {
    state.ambiguousDelete = op;
  }
  // `fail`: definite non-delete — no state change.
}

/** Check one read/list observation against the current entity state. */
function checkObservation(
  state: EntityState,
  op: ProbeOpRecord,
  entity: string,
  obsKind: 'read' | 'list',
  toleranceMs: number,
  checks: GuaranteeCheck[],
): void {
  // --- Post-delete window: no-resurrection ---
  if (state.deletedMarker !== null && state.deleteOp !== null) {
    const chain = [witnessOf(state.deleteOp), witnessOf(op)];
    if (state.ambiguousDelete !== null || state.ambiguousWrite !== null) {
      checks.push(
        inconclusive(
          'no-resurrection',
          entity,
          chain,
          `Post-delete ${obsKind} ${op.opId} cannot confirm no-resurrection: an indeterminate op leaves the entity possibly-present.`,
          'indeterminate delete/write in the window',
        ),
      );
      return;
    }
    if (op.outcome !== 'ok') {
      checks.push(
        inconclusive(
          'no-resurrection',
          entity,
          chain,
          `Post-delete ${obsKind} ${op.opId} returned a non-2xx/indeterminate outcome (${op.outcome}); no marker observation.`,
          `observation outcome ${op.outcome}`,
        ),
      );
      return;
    }
    const present = bodyContainsMarker(op.response?.body, state.deletedMarker);
    if (present) {
      checks.push({
        guarantee: 'no-resurrection',
        entity,
        verdict: 'violated',
        witness: chain,
        detail: `Marker ${state.deletedMarker} was deleted by op ${state.deleteOp.opId} (ok at t=${state.deleteOp.completeTs}) but reappeared in ${obsKind} ${op.opId} (ok at t=${op.completeTs}).`,
      });
    } else {
      checks.push({
        guarantee: 'no-resurrection',
        entity,
        verdict: 'holds',
        witness: chain,
        detail: `Marker ${state.deletedMarker} deleted by ${state.deleteOp.opId} did not reappear in ${obsKind} ${op.opId}.`,
      });
    }
    return;
  }

  // --- No established write yet: nothing marker-based to assert ---
  if (state.established === null) {
    if (state.ambiguousWrite !== null) {
      checks.push(
        inconclusive(
          obsKind === 'read' ? 'read-your-writes' : 'create-appears-in-list',
          entity,
          [witnessOf(state.ambiguousWrite), witnessOf(op)],
          `${obsKind} ${op.opId} follows an indeterminate write (${state.ambiguousWrite.opId}); the marker may or may not have been applied.`,
          'preceding write is indeterminate',
        ),
      );
    }
    // else: no write to read back (e.g. create failed) — no check.
    return;
  }

  const est = state.established;
  const kind: GuaranteeKind = decideKind(obsKind, est);
  const chain = [witnessOf(est.writeOp), witnessOf(op)];

  // Ambiguous current state from an indeterminate write: inconclusive.
  if (state.ambiguousWrite !== null) {
    checks.push(
      inconclusive(
        kind,
        entity,
        [witnessOf(est.writeOp), witnessOf(state.ambiguousWrite), witnessOf(op)],
        `${obsKind} ${op.opId} cannot be decided: an indeterminate write (${state.ambiguousWrite.opId}) left the current marker ambiguous.`,
        'intervening indeterminate write',
      ),
    );
    return;
  }
  if (state.ambiguousDelete !== null) {
    checks.push(
      inconclusive(
        kind,
        entity,
        [witnessOf(state.ambiguousDelete), witnessOf(op)],
        `${obsKind} ${op.opId} cannot be decided: an indeterminate delete (${state.ambiguousDelete.opId}) leaves the entity possibly-absent.`,
        'intervening indeterminate delete',
      ),
    );
    return;
  }

  // The observation itself must be definite to carry marker evidence.
  if (op.outcome !== 'ok') {
    checks.push(
      inconclusive(
        kind,
        entity,
        chain,
        `${obsKind} ${op.opId} returned a non-2xx/indeterminate outcome (${op.outcome}); no marker observation to compare.`,
        `observation outcome ${op.outcome}`,
      ),
    );
    return;
  }

  const present = bodyContainsMarker(op.response?.body, est.marker);
  if (present) {
    est.observed = true;
    checks.push({
      guarantee: kind,
      entity,
      verdict: 'holds',
      witness: chain,
      detail: `Marker ${est.marker} written by ${est.writeOp.opId} (ok ${est.kind} at t=${est.writeOp.completeTs}) was reflected in ${obsKind} ${op.opId} (ok at t=${op.completeTs}).`,
    });
    return;
  }

  // Missing. A list within the eventual-consistency window is tolerated.
  if (
    obsKind === 'list' &&
    toleranceMs > 0 &&
    op.completeTs - est.writeOp.completeTs <= toleranceMs
  ) {
    checks.push({
      guarantee: kind,
      entity,
      verdict: 'inconclusive',
      witness: chain,
      detail: `List ${op.opId} did not yet contain marker ${est.marker} written by ${est.writeOp.opId}, but is within the eventual-consistency window.`,
      inconclusiveReason: 'within eventual-consistency tolerance window',
      toleranceNote: `list at t=${op.completeTs} is ${op.completeTs - est.writeOp.completeTs}ms after write t=${est.writeOp.completeTs} (tolerance ${toleranceMs}ms)`,
    });
    return;
  }

  // A regression of a previously-observed marker is a monotonic violation;
  // a marker that never became visible is a read-your-writes / list violation.
  const violated: GuaranteeKind = est.observed ? 'monotonic-reads' : kind;
  checks.push({
    guarantee: violated,
    entity,
    verdict: 'violated',
    witness: chain,
    detail: est.observed
      ? `Marker ${est.marker} (written by ${est.writeOp.opId}, ok at t=${est.writeOp.completeTs}) was previously observed but is absent from ${obsKind} ${op.opId} (ok at t=${op.completeTs}) — a monotonic regression.`
      : `Marker ${est.marker} written by ${est.writeOp.opId} (ok ${est.kind} at t=${est.writeOp.completeTs}) was NOT reflected in ${obsKind} ${op.opId} (ok at t=${op.completeTs}).`,
  });
}

/** Read observations map to read-your-writes; lists on a fresh create map to
 * create-appears-in-list, and to monotonic once the marker was seen (decided by
 * the caller via the `observed` flag on a violation). */
function decideKind(obsKind: 'read' | 'list', est: Established): GuaranteeKind {
  if (obsKind === 'read') return 'read-your-writes';
  return est.kind === 'create' ? 'create-appears-in-list' : 'read-your-writes';
}

function inconclusive(
  guarantee: GuaranteeKind,
  entity: string,
  witness: GuaranteeWitnessOp[],
  detail: string,
  reason: string,
): GuaranteeCheck {
  return {
    guarantee,
    entity,
    verdict: 'inconclusive',
    witness,
    detail,
    inconclusiveReason: reason,
  };
}

const GUARANTEE_KINDS: GuaranteeKind[] = [
  'read-your-writes',
  'monotonic-reads',
  'no-resurrection',
  'create-appears-in-list',
];

function buildReport(checks: GuaranteeCheck[], toleranceMs: number): SessionGuaranteeReport {
  const byGuarantee = Object.fromEntries(
    GUARANTEE_KINDS.map((k) => [k, { holds: 0, violated: 0, inconclusive: 0 }]),
  ) as Record<GuaranteeKind, GuaranteeCounts>;

  let holds = 0;
  let violated = 0;
  let inconclusive = 0;
  for (const c of checks) {
    if (c.verdict === 'holds') {
      holds++;
      byGuarantee[c.guarantee].holds++;
    } else if (c.verdict === 'violated') {
      violated++;
      byGuarantee[c.guarantee].violated++;
    } else {
      inconclusive++;
      byGuarantee[c.guarantee].inconclusive++;
    }
  }

  return {
    checks,
    anomalies: checks.filter((c) => c.verdict === 'violated'),
    summary: { total: checks.length, holds, violated, inconclusive, byGuarantee },
    nonClaims: [
      'No isolation-level inference: session guarantees are per-session checkable; isolation anomaly detection requires designed multi-session histories, which are out of scope for this epic.',
      'Indeterminate operations are treated as possibly-applied: any dependent check is marked inconclusive, never reported as an anomaly.',
      'Non-2xx observations carry no marker evidence and are inconclusive rather than violations.',
      'Only marker-tagged entities are checked: an entity with no writable marker field yields no guarantee verdicts.',
      `Eventual consistency: a list that misses a just-written marker within the configured tolerance window (${toleranceMs}ms) is reported clean with the tolerance noted, not as an anomaly.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Binding into verify-result (asymmetric, mirrors src/monitor/verdict-merge.ts)
// ---------------------------------------------------------------------------

export type GuaranteeEventType = 'guarantee:violation' | 'guarantee:corroboration';

export interface MergeGuaranteeOptions {
  /**
   * Which behaviors bind to which guarantees. A behavior appears here iff it is
   * tagged `data-consistency` (the caller derives this from the spec). The value
   * restricts binding to specific guarantee kinds, or `'all'` binds every kind.
   * Behaviors not present in the map are left untouched.
   */
  bindings: Map<string, GuaranteeKind[] | 'all'>;
  emit?: (type: GuaranteeEventType, data: Record<string, unknown>) => void;
}

export interface MergeGuaranteeResult {
  /** The merged structured output. Unchanged (identical by reference) when no binding applied. */
  output: unknown;
  /** Behavior ids the checker forced from passed/skipped to failed. */
  guaranteeForcedFailures: string[];
  /** Total guarantee checks attached across all behaviors. */
  checksAttached: number;
}

interface VerifyOutput {
  pass?: boolean;
  summary?: { total: number; passed: number; failed: number; skipped: number };
  results: BehaviorResult[];
  [key: string]: unknown;
}

function hasResultsArray(output: unknown): output is VerifyOutput {
  return !!output && typeof output === 'object' && Array.isArray((output as VerifyOutput).results);
}

/**
 * Merge session-guarantee verdicts into the structured verify output, binding
 * them to `data-consistency`-tagged behaviors.
 *
 * ASYMMETRIC RECONCILIATION (mirrors the monitor merge, and for the same
 * reason — the checker is a reviewed, fully deterministic consequence):
 *  - a `violated` bound guarantee forces the behavior to `failed`; a witnessed
 *    anomaly is ground truth. `guarantee_source` becomes `guarantee`.
 *  - `holds` + LLM passed corroborates: `guarantee_source` becomes
 *    `guarantee+llm`. A `holds` NEVER overturns an LLM fail (the guarantee
 *    covers only the data-consistency slice, not the whole behavior claim).
 *  - `inconclusive` NEVER affects status: an indeterminate op or a truncated
 *    workload is not evidence of anything.
 *
 * Pure: the input `structuredOutput` object is never mutated.
 */
export function mergeGuaranteeVerdicts(
  structuredOutput: unknown,
  report: SessionGuaranteeReport,
  opts: MergeGuaranteeOptions,
): MergeGuaranteeResult {
  const noop: MergeGuaranteeResult = {
    output: structuredOutput,
    guaranteeForcedFailures: [],
    checksAttached: 0,
  };
  if (!hasResultsArray(structuredOutput)) return noop;
  if (opts.bindings.size === 0) return noop;

  const applies = structuredOutput.results.some(
    (r) => typeof r.id === 'string' && opts.bindings.has(r.id),
  );
  if (!applies) return noop;

  const emit = opts.emit ?? (() => {});
  const guaranteeForcedFailures: string[] = [];
  let checksAttached = 0;

  const mergedResults = structuredOutput.results.map((result): BehaviorResult => {
    const binding = typeof result.id === 'string' ? opts.bindings.get(result.id) : undefined;
    if (binding === undefined) return result;

    const bound = report.checks.filter((c) => binding === 'all' || binding.includes(c.guarantee));
    if (bound.length === 0) return result;
    checksAttached += bound.length;

    const violations = bound.filter((c) => c.verdict === 'violated');
    const anyHolds = bound.some((c) => c.verdict === 'holds');
    const merged: BehaviorResult = { ...result, guarantees: bound };

    if (violations.length > 0) {
      const flipped = result.status !== 'failed';
      merged.status = 'failed';
      merged.guarantee_source = 'guarantee';
      if (flipped) guaranteeForcedFailures.push(result.id);
      const details = violations
        .map((v) => `[guarantee] ${v.guarantee} violated for ${v.entity}: ${v.detail}`)
        .join(' ');
      merged.rationale = result.rationale ? `${result.rationale} ${details}` : details;
      for (const v of violations) {
        emit('guarantee:violation', {
          behavior: result.id,
          guarantee: v.guarantee,
          entity: v.entity,
          witness: v.witness,
        });
      }
    } else if (anyHolds && result.status === 'passed') {
      merged.guarantee_source = 'guarantee+llm';
      emit('guarantee:corroboration', { behavior: result.id });
    } else {
      merged.guarantee_source = 'llm';
    }

    return merged;
  });

  const passed = mergedResults.filter((r) => r.status === 'passed').length;
  const failed = mergedResults.filter((r) => r.status === 'failed').length;
  const skipped = mergedResults.filter((r) => r.status === 'skipped').length;

  const output: VerifyOutput = {
    ...structuredOutput,
    results: mergedResults,
    summary: { total: mergedResults.length, passed, failed, skipped },
    pass: failed === 0,
  };

  return { output, guaranteeForcedFailures, checksAttached };
}
