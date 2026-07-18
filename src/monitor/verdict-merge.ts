/**
 * src/monitor/verdict-merge.ts — Merge deterministic LTLf monitor verdicts
 * into the agent's structured verify output.
 *
 * This is the point of the whole monitor tier: compiled formulas
 * (specify.formulas.yaml, src/spec/formulas.ts) are evaluated over the
 * runner-recorded trace and their verdicts flow into the per-behavior
 * results — POST-HOC, after the agent finishes, exactly like the `repro`
 * field (the LLM never sees or produces monitor fields; they are
 * deliberately absent from the SDK output schema in sdk-runner.ts).
 *
 * ASYMMETRIC RECONCILIATION (the trust model — do not "simplify"):
 *
 *   - violated APPROVED formula  -> behavior status forced to 'failed'
 *     (monitor wins). The formula is a reviewed, deterministic consequence
 *     of the behavior claim; a witnessed violation is ground truth the LLM
 *     missed. Rationale gets the witness detail appended.
 *   - satisfied + LLM passed     -> passed, verdict_source 'monitor+llm'
 *     (corroborated).
 *   - satisfied NEVER overturns an LLM fail. A formula checks only the
 *     machine-checkable consequence that was compiled, not the whole
 *     plain-language claim — the LLM may have failed the behavior for a
 *     reason the formula does not cover. Status stays 'failed'; the
 *     disagreement is flagged on the verdict entry (and surfaced as a
 *     'monitor:disagreement' event) for burn-in review.
 *   - inconclusive / unevaluable NEVER affect status. Truncated runs and
 *     missing capture data are not evidence of anything.
 *   - DRAFT formulas evaluate in SHADOW MODE: verdicts are attached as
 *     advisory metadata but never affect status, verdict_source, events or
 *     the exit code. This is how the burn-in corpus for later promotion to
 *     'approved' gets built. 'rejected' formulas are not evaluated at all.
 *
 * PREFIX SEMANTICS: the run is a truncated window of the system's life, so
 * every formula is evaluated with `traceComplete: false` (see evaluate.ts) —
 * an obligation the run simply never reached is 'inconclusive', not a
 * violation.
 *
 * IN-MEMORY DATA ONLY: the merge runs inside runSpecifyAgent immediately
 * after the agent query returns, BEFORE the finally block that calls
 * collector.save()/recorder.save() — so evidence FILES do not exist yet.
 * `buildVerifyTrace` therefore consumes the in-memory step records and
 * traffic/console arrays directly. The one exception: AX snapshot YAML
 * files ARE on disk already (ObservationRecorder.captureAx writes them
 * incrementally per-step; only observations.json waits for save()), so
 * `ax.role` works at merge time given `axBaseDir` = the capture output dir.
 *
 * LIFECYCLE TELEMETRY (SP-34f, optional — pass `opts.statsFile`): every
 * verdict computed here is also folded into a FormulaStatsFile
 * (./formula-stats.ts) — per-formula run history that backs shadow-mode
 * promotion suggestions, grounding-drift flags, and recompile-on-disagreement
 * flags. A 'satisfied' verdict is additionally checked for vacuity
 * (./vacuity.ts: did the formula's antecedent ever actually fire in this
 * trace?) — a vacuous pass is labeled on the verdict (`vacuous: true`) and
 * counted as neither shadow-mode agreement nor disagreement, so a formula
 * can't "earn" promotion purely by never being exercised.
 */

import type { CapturedConsoleEntry, CapturedTraffic } from '../capture/types.js';
import type { StepObservation } from '../agent/observation.js';
import type { BehaviorResult, MonitorVerdict } from '../spec/types.js';
import type { FormulasFile, FormulaEntry } from '../spec/formulas.js';
import { evaluate, type WitnessContext } from './evaluate.js';
import { buildEventTimeline, type Trace, type TraceEvent } from './trace.js';
import {
  createRegistryEvaluator,
  httpTraceEvent,
  consoleTraceEvent,
  type HttpTraceEvent,
  type ConsoleTraceEvent,
} from './predicates.js';
import { isVacuouslySatisfied } from './vacuity.js';
import { recordFormulaVerdict, type FormulaStatsFile } from './formula-stats.js';

// ---------------------------------------------------------------------------
// Trace construction from in-memory run data
// ---------------------------------------------------------------------------

/**
 * Build the monitor trace from the runner's in-memory data.
 *
 * STEP-POSITION mode (steps present): positions are the recorder's step
 * records; each position's event window is derived from the recorder's
 * traffic/console INDEX SLICES, not timestamps. The recorder leaves the
 * LAST step's slice end open until save() (which has not run yet at merge
 * time), so window ends are recomputed as "next step's slice start" (final
 * step: the array's current length) — equivalent to the recorder's own
 * closing rule and robust to the open range.
 *
 * EVENT-TIMELINE fallback (no steps — e.g. a run recorded before the
 * observation recorder existed, or a browserless path): every captured
 * traffic/console entry becomes one position. Event-only formulas remain
 * evaluable; step predicates yield 'unevaluable' at every position (no
 * `step` field), which the asymmetric policy guarantees can never flip a
 * status.
 */
export function buildVerifyTrace(
  steps: readonly StepObservation[],
  traffic: readonly CapturedTraffic[],
  consoleLogs: readonly CapturedConsoleEntry[],
): Trace {
  const allEvents = (): TraceEvent[] => [
    ...traffic.map((t) => httpTraceEvent(t)),
    ...consoleLogs.map((c) => consoleTraceEvent(c)),
  ];

  if (steps.length === 0) {
    return buildEventTimeline(allEvents());
  }

  return steps.map((step, index) => {
    const trafficStart = step.trafficRange[0];
    const trafficEnd = index + 1 < steps.length ? steps[index + 1].trafficRange[0] : traffic.length;
    const consoleStart = step.consoleRange[0];
    const consoleEnd = index + 1 < steps.length ? steps[index + 1].consoleRange[0] : consoleLogs.length;

    const events: TraceEvent[] = [
      ...traffic.slice(trafficStart, Math.max(trafficStart, trafficEnd)).map((t) => httpTraceEvent(t)),
      ...consoleLogs.slice(consoleStart, Math.max(consoleStart, consoleEnd)).map((c) => consoleTraceEvent(c)),
    ].sort((a, b) => a.ts - b.ts);

    return { index, events, step };
  });
}

// ---------------------------------------------------------------------------
// Witness rendering
// ---------------------------------------------------------------------------

function isStepObservation(step: unknown): step is StepObservation {
  return (
    !!step &&
    typeof step === 'object' &&
    typeof (step as StepObservation).action === 'string' &&
    typeof (step as StepObservation).urlAfter === 'string'
  );
}

function describeEvent(ev: TraceEvent): string {
  if (ev.kind === 'http') {
    const t = (ev as HttpTraceEvent).traffic;
    return `${t.method} ${t.url} -> ${t.status ?? '?'}`;
  }
  if (ev.kind === 'console') {
    const e = (ev as ConsoleTraceEvent).entry;
    const text = e.text.length > 120 ? `${e.text.slice(0, 120)}…` : e.text;
    return `console.${e.type}: ${text}`;
  }
  return ev.kind;
}

/** Render the decisive trace position into a human-readable witness detail. */
export function describeWitnessState(ctx: WitnessContext): string {
  const parts: string[] = [`position ${ctx.position}`];
  if (isStepObservation(ctx.state.step)) {
    const step = ctx.state.step;
    const selector = typeof step.args?.selector === 'string' ? ` ${step.args.selector}` : '';
    parts.push(`step ${step.step} (${step.action}${selector}) at ${step.urlAfter || '(no url)'}`);
  }
  const events = ctx.state.events;
  if (events.length > 0) {
    const shown = events.slice(0, 3).map((ev) => describeEvent(ev)).join('; ');
    const more = events.length > 3 ? ` (+${events.length - 3} more)` : '';
    parts.push(`events: ${shown}${more}`);
  }
  return parts.join(' — ');
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Shape of the structured verify output the merge operates on. */
interface VerifyOutput {
  pass?: boolean;
  summary?: { total: number; passed: number; failed: number; skipped: number };
  results: BehaviorResult[];
  [key: string]: unknown;
}

export type MonitorEventType =
  | 'monitor:violation'
  | 'monitor:disagreement'
  | 'monitor:vacuous'
  | 'monitor:promotion_suggested'
  | 'monitor:drift_detected'
  | 'monitor:recompile_flagged';

export interface MergeMonitorOptions {
  /** Base dir for AX snapshot files (the capture outputDir). Enables ax.role. */
  axBaseDir?: string;
  /** Event sink for the MonitorEventType union. */
  emit?: (type: MonitorEventType, data: Record<string, unknown>) => void;
  /**
   * Existing formula-stats file (src/monitor/formula-stats.ts) to fold this
   * run's verdicts into. Omit to skip telemetry entirely (no
   * `formulaStats` on the result). Persistence is the caller's job — this
   * function is pure and returns the updated file rather than writing it.
   */
  statsFile?: FormulaStatsFile;
}

/** Telemetry produced this run, present only when `opts.statsFile` was provided. */
export interface FormulaStatsUpdate {
  /** The updated stats file — persist this (see formula-stats.ts's saveFormulaStats). */
  file: FormulaStatsFile;
  /** Draft formula ids whose agreement streak crossed the promotion threshold THIS run. */
  promotionSuggested: string[];
  /** Formula ids whose grounding-drift flag was newly set THIS run. */
  driftDetected: string[];
  /** Approved formula ids whose recompile flag was newly set THIS run. */
  recompileFlagged: string[];
}

export interface MergeMonitorResult {
  /**
   * The merged structured output. When no formula applied to any behavior in
   * the output, this is the ORIGINAL object, unchanged and identical by
   * reference. Otherwise it is a fresh object (the input is never mutated).
   */
  output: unknown;
  /** Behaviors whose status the monitor forced from passed/skipped to failed. */
  monitorForcedFailures: string[];
  /** Total formula verdicts attached across all behaviors. */
  verdictsAttached: number;
  /** Present iff opts.statsFile was provided (see FormulaStatsUpdate). */
  formulaStats?: FormulaStatsUpdate;
}

function hasResultsArray(output: unknown): output is VerifyOutput {
  return (
    !!output &&
    typeof output === 'object' &&
    Array.isArray((output as VerifyOutput).results)
  );
}

/**
 * Evaluate every draft/approved formula against the trace and merge verdicts
 * into the structured verify output per the asymmetric policy documented in
 * the module header. Pure with respect to its inputs: the original
 * `structuredOutput` object is never mutated.
 */
export function mergeMonitorVerdicts(
  structuredOutput: unknown,
  formulasFile: FormulasFile,
  trace: Trace,
  opts: MergeMonitorOptions = {},
): MergeMonitorResult {
  const noop: MergeMonitorResult = {
    output: structuredOutput,
    monitorForcedFailures: [],
    verdictsAttached: 0,
  };
  if (!hasResultsArray(structuredOutput)) return noop;

  const evaluable = formulasFile.formulas.filter(
    (f) => f.status === 'draft' || f.status === 'approved',
  );
  if (evaluable.length === 0) return noop;

  const byBehavior = new Map<string, FormulaEntry[]>();
  for (const entry of evaluable) {
    const list = byBehavior.get(entry.behavior) ?? [];
    list.push(entry);
    byBehavior.set(entry.behavior, list);
  }

  // Any formula for a behavior present in the output?
  const applies = structuredOutput.results.some(
    (r) => typeof r.id === 'string' && byBehavior.has(r.id),
  );
  if (!applies) return noop;

  const evaluator = createRegistryEvaluator(trace, { axBaseDir: opts.axBaseDir });
  const emit = opts.emit ?? (() => {});
  const monitorForcedFailures: string[] = [];
  let verdictsAttached = 0;

  let statsFile = opts.statsFile;
  const promotionSuggested: string[] = [];
  const driftDetected: string[] = [];
  const recompileFlagged: string[] = [];

  const mergedResults = structuredOutput.results.map((result): BehaviorResult => {
    const formulas = typeof result.id === 'string' ? byBehavior.get(result.id) : undefined;
    if (!formulas || formulas.length === 0) return result;

    const verdicts: MonitorVerdict[] = [];
    const approvedViolations: MonitorVerdict[] = [];
    let approvedSatisfied = false;

    for (const entry of formulas) {
      const evaluated = evaluate(entry.formula, trace, evaluator, {
        traceComplete: false,
        describeWitness: describeWitnessState,
      });

      // Vacuity: only a 'satisfied' verdict can be vacuous (an implication
      // whose antecedent never fired trivially "holds"); violated/
      // inconclusive/unevaluable verdicts are never vacuous.
      const vacuous =
        evaluated.verdict === 'satisfied' && isVacuouslySatisfied(entry.formula, trace, evaluator);

      const verdict: MonitorVerdict = {
        formula_id: entry.id,
        status: entry.status as 'draft' | 'approved',
        verdict: evaluated.verdict,
        ...(evaluated.witnessStep !== undefined ? { witness_step: evaluated.witnessStep } : {}),
        ...(evaluated.witnessDetail !== undefined ? { witness_detail: evaluated.witnessDetail } : {}),
        trace_length: trace.length,
        ...(vacuous ? { vacuous: true } : {}),
      };

      // Flag monitor-satisfied vs LLM-failed disagreements on both approved
      // and shadow-mode draft entries (drafts: advisory metadata only).
      if (evaluated.verdict === 'satisfied' && result.status === 'failed') {
        verdict.disagreement = true;
      }

      if (vacuous) {
        emit('monitor:vacuous', {
          behavior: result.id,
          formula_id: entry.id,
          witness_step: evaluated.witnessStep,
        });
      }

      if (entry.status === 'approved') {
        if (evaluated.verdict === 'violated') {
          approvedViolations.push(verdict);
          emit('monitor:violation', {
            behavior: result.id,
            formula_id: entry.id,
            witness_step: evaluated.witnessStep,
            witness_detail: evaluated.witnessDetail,
            llm_status: result.status,
          });
        } else if (evaluated.verdict === 'satisfied') {
          approvedSatisfied = true;
          if (result.status === 'failed') {
            emit('monitor:disagreement', {
              behavior: result.id,
              formula_id: entry.id,
              llm_status: result.status,
              monitor_verdict: 'satisfied',
            });
          }
        }
        // inconclusive / unevaluable: attached, never affect status.
      }

      verdicts.push(verdict);
      verdictsAttached++;

      // Lifecycle telemetry (SP-34f): fold this verdict into the stats file,
      // keyed on the LLM's OWN status for this behavior (result.status),
      // independent of whatever the merge below decides for `merged.status`.
      if (statsFile) {
        const recorded = recordFormulaVerdict(statsFile, {
          formulaId: entry.id,
          formulaStatus: entry.status as 'draft' | 'approved',
          verdict: evaluated.verdict,
          llmStatus: result.status,
          vacuous,
        });
        statsFile = recorded.file;
        if (recorded.promotionJustSuggested) {
          promotionSuggested.push(entry.id);
          emit('monitor:promotion_suggested', { behavior: result.id, formula_id: entry.id });
        }
        if (recorded.driftJustDetected) {
          driftDetected.push(entry.id);
          emit('monitor:drift_detected', { behavior: result.id, formula_id: entry.id });
        }
        if (recorded.recompileJustFlagged) {
          recompileFlagged.push(entry.id);
          emit('monitor:recompile_flagged', { behavior: result.id, formula_id: entry.id });
        }
      }
    }

    const merged: BehaviorResult = { ...result, monitor: verdicts };

    if (approvedViolations.length > 0) {
      // Monitor wins: force 'failed'. If the LLM already failed it, monitor
      // and LLM concur.
      const flipped = result.status !== 'failed';
      merged.status = 'failed';
      merged.verdict_source = flipped ? 'monitor' : 'monitor+llm';
      if (flipped) monitorForcedFailures.push(result.id);
      const details = approvedViolations
        .map((v) => `[monitor] Formula ${v.formula_id} violated${v.witness_detail ? `: ${v.witness_detail}` : ''}`)
        .join(' ');
      merged.rationale = result.rationale ? `${result.rationale} ${details}` : details;
    } else if (approvedSatisfied && result.status === 'passed') {
      merged.verdict_source = 'monitor+llm';
    } else {
      // Shadow-mode drafts, inconclusive/unevaluable approved verdicts, or a
      // satisfied verdict that cannot overturn an LLM fail: the LLM's call
      // stands. The disagreement (if any) is flagged on the verdict entry.
      merged.verdict_source = 'llm';
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

  return {
    output,
    monitorForcedFailures,
    verdictsAttached,
    ...(statsFile
      ? { formulaStats: { file: statsFile, promotionSuggested, driftDetected, recompileFlagged } }
      : {}),
  };
}

/**
 * True iff the output has at least one failed behavior AND every failed
 * behavior was failed solely by the monitor (verdict_source 'monitor').
 * Drives ExitCode.MONITOR_VIOLATION: "all LLM-passed but a formula
 * violated". Mixed failures (any behavior the LLM itself failed) return
 * false and keep ASSERTION_FAILURE.
 */
export function isMonitorOnlyFailure(structuredOutput: unknown): boolean {
  if (!hasResultsArray(structuredOutput)) return false;
  const failed = structuredOutput.results.filter((r) => r.status === 'failed');
  if (failed.length === 0) return false;
  return failed.every((r) => r.verdict_source === 'monitor');
}

// ---------------------------------------------------------------------------
// Runner-facing convenience: build trace + merge in one call
// ---------------------------------------------------------------------------

export interface RunMergeInputs {
  steps: readonly StepObservation[];
  traffic: readonly CapturedTraffic[];
  consoleLogs: readonly CapturedConsoleEntry[];
  axBaseDir?: string;
  emit?: (type: MonitorEventType, data: Record<string, unknown>) => void;
  /** See MergeMonitorOptions.statsFile. Omit to skip lifecycle telemetry. */
  statsFile?: FormulaStatsFile;
}

/** One-call wrapper used by runSpecifyAgent: build the trace from in-memory run data, then merge. */
export function mergeMonitorVerdictsForRun(
  structuredOutput: unknown,
  formulasFile: FormulasFile,
  inputs: RunMergeInputs,
): MergeMonitorResult {
  const trace = buildVerifyTrace(inputs.steps, inputs.traffic, inputs.consoleLogs);
  return mergeMonitorVerdicts(structuredOutput, formulasFile, trace, {
    axBaseDir: inputs.axBaseDir,
    emit: inputs.emit,
    statsFile: inputs.statsFile,
  });
}
