/**
 * src/monitor/trace.ts — Trace model + predicate-evaluation interface for the
 * LTLf monitor.
 *
 * TWO-SORTED SEMANTICS (the main correctness trap)
 * ------------------------------------------------
 * A recorded run mixes two kinds of observable:
 *
 *   - STATE observations, which hold *at* a position (a step record — the DOM
 *     snapshot, the process state, the current URL, ...). A state predicate is
 *     evaluated against `state.step`.
 *
 *   - EVENT observations, which happen *between* positions (a click, a network
 *     response, a console line). An event predicate holds at position i iff a
 *     matching event occurred in the window between position i-1 and position i.
 *     Those windowed events are carried on `state.events`.
 *
 * Because state predicates and event predicates read different fields of the same
 * `TraceState`, the two sorts co-exist on a single linear sequence of positions.
 * Whether a given predicate is a state predicate or an event predicate is the job
 * of the predicate registry (a later bead); this file only defines the interface
 * it must satisfy and the two builders that lay events onto positions.
 *
 * Two trace-construction modes:
 *
 *   1. STEP-POSITION mode (`buildStepTrace`): positions are step records; each
 *      captured event is bucketed into the window ending at the step whose
 *      timestamp first reaches or exceeds it.
 *
 *   2. EVENT-TIMELINE fallback (`buildEventTimeline`): when there are no step
 *      records, every captured event (timestamp-ordered) becomes one position.
 */

/** A single captured event. `ts` is a timestamp (ms); `kind` is a coarse tag. */
export interface TraceEvent {
  ts: number;
  kind: string;
  [field: string]: unknown;
}

/**
 * One position of the trace.
 *   - `index`  — 0-based position in the trace.
 *   - `events` — events that occurred in the window ending at this position.
 *   - `step`   — optional state/step record. Placeholder `unknown` type; the
 *                concrete step-record shape lands with the capture-integration bead.
 */
export interface TraceState {
  index: number;
  events: TraceEvent[];
  step?: unknown;
}

/** A trace is just an ordered array of positions. */
export type Trace = TraceState[];

/**
 * Verdict a predicate can return at a position.
 *   - `true`         — the predicate definitely holds here.
 *   - `false`        — the predicate definitely does not hold here.
 *   - `'unevaluable'`— the predicate could not be evaluated (missing data,
 *                      malformed capture, unknown selector, ...). Treated as
 *                      Kleene "unknown" by the evaluator.
 */
export type PredicateVerdict = true | false | 'unevaluable';

/** The atomic-proposition part of a formula, as handed to the evaluator. */
export interface PredicateRef {
  name: string;
  args: string[];
}

/**
 * Injected predicate evaluator. The registry (later bead) provides an
 * implementation; the LTLf evaluator only ever calls `eval`.
 */
export interface PredicateEvaluator {
  eval(pred: PredicateRef, state: TraceState): PredicateVerdict;
}

/** Convenience: build a PredicateEvaluator from a plain function. */
export function predicateEvaluator(
  fn: (pred: PredicateRef, state: TraceState) => PredicateVerdict,
): PredicateEvaluator {
  return { eval: fn };
}

/** A step record paired with the timestamp at which it was captured. */
export interface StepInput {
  ts: number;
  step: unknown;
}

/**
 * STEP-POSITION builder.
 *
 * Positions correspond one-to-one with `steps` (kept in input order, which is
 * assumed timestamp-ascending). Each event is assigned to the earliest step whose
 * timestamp is >= the event timestamp — i.e. the window (prevStep.ts, step.ts].
 * Events at or before the first step land in position 0's window. Events after the
 * last step's timestamp are attached to the last position (they occurred within
 * the final observed window of the run).
 */
export function buildStepTrace(steps: StepInput[], events: TraceEvent[]): Trace {
  const states: Trace = steps.map((s, index) => ({ index, events: [], step: s.step }));
  if (states.length === 0) return states;

  const sortedEvents = [...events].sort((a, b) => a.ts - b.ts);
  for (const event of sortedEvents) {
    // Find the first step whose timestamp reaches the event; that step's window
    // is the one the event belongs to.
    let target = steps.findIndex((s) => s.ts >= event.ts);
    if (target === -1) target = states.length - 1; // after the last step
    states[target].events.push(event);
  }
  return states;
}

/**
 * EVENT-TIMELINE fallback builder.
 *
 * Every event becomes its own position (timestamp-ordered). There are no step
 * records, so `step` is left undefined and each position's `events` holds exactly
 * the one event that defines it.
 */
export function buildEventTimeline(events: TraceEvent[]): Trace {
  return [...events]
    .sort((a, b) => a.ts - b.ts)
    .map((event, index) => ({ index, events: [event], step: undefined }));
}
