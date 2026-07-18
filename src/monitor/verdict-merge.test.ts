/**
 * src/monitor/verdict-merge.test.ts — Fixture tests for the asymmetric
 * monitor-verdict merge (verdict-merge.ts). Pure synthetic traces — no live
 * browser. The runner's merge path is exercised at its boundary via
 * mergeMonitorVerdictsForRun with in-memory step/traffic/console fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CapturedConsoleEntry, CapturedTraffic } from '../capture/types.js';
import type { StepObservation } from '../agent/observation.js';
import type { BehaviorResult } from '../spec/types.js';
import type { FormulaEntry, FormulasFile, FormulaStatus } from '../spec/formulas.js';
import { eventually, globally, not, pred, type Formula } from './formula.js';
import { canonicalProbeKey } from './predicates.js';
import {
  buildVerifyTrace,
  isMonitorOnlyFailure,
  mergeMonitorVerdicts,
  mergeMonitorVerdictsForRun,
  type MonitorEventType,
} from './verdict-merge.js';

// --- Fixture helpers ---------------------------------------------------------

function traffic(url: string, status: number, ts: number, extra: Partial<CapturedTraffic> = {}): CapturedTraffic {
  return {
    url,
    method: 'GET',
    postData: null,
    status,
    contentType: 'application/json',
    ts,
    tsStart: ts - 5,
    tsEnd: ts,
    responseBody: null,
    ...extra,
  };
}

function consoleEntry(type: string, text: string, ts: number): CapturedConsoleEntry {
  return { type, text, ts };
}

function step(n: number, overrides: Partial<StepObservation> = {}): StepObservation {
  return {
    step: n,
    action: 'click',
    success: true,
    urlBefore: 'https://app.test/',
    urlAfter: 'https://app.test/page',
    tsStart: 1000 * n,
    tsEnd: 1000 * n + 500,
    ax: { error: 'not captured' },
    trafficRange: [0, 0],
    consoleRange: [0, 0],
    ...overrides,
  };
}

function formulaEntry(
  behavior: string,
  formula: Formula,
  status: FormulaStatus,
  id = `fml-${behavior.replace(/[^a-z0-9]/gi, '').slice(0, 4)}${status.slice(0, 2)}`,
): FormulaEntry {
  return {
    id,
    behavior,
    description_hash: 'sha256:0000',
    formula,
    predicates_used: [],
    status,
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  };
}

function formulasFile(...formulas: FormulaEntry[]): FormulasFile {
  return { version: 1, predicates_version: 1, formulas };
}

function behaviorResult(id: string, status: 'passed' | 'failed' | 'skipped', rationale?: string): BehaviorResult {
  return { id, description: `behavior ${id}`, status, ...(rationale ? { rationale } : {}) };
}

interface VerifyOut {
  pass: boolean;
  summary: { total: number; passed: number; failed: number; skipped: number };
  results: BehaviorResult[];
}

function verifyOutput(...results: BehaviorResult[]): VerifyOut {
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return {
    pass: failed === 0,
    summary: { total: results.length, passed, failed, skipped },
    results,
  };
}

type EmittedEvent = { type: MonitorEventType; data: Record<string, unknown> };

function emitSink(): { events: EmittedEvent[]; emit: (type: MonitorEventType, data: Record<string, unknown>) => void } {
  const events: EmittedEvent[] = [];
  return { events, emit: (type, data) => events.push({ type, data }) };
}

// A trace where /api/save returned 500 in the window of step 1.
function serverErrorTrace() {
  const steps = [
    step(0, { action: 'goto', trafficRange: [0, 1], consoleRange: [0, 0] }),
    step(1, { trafficRange: [1, 2], consoleRange: [0, 1] }),
  ];
  const t = [traffic('https://app.test/api/session', 200, 100), traffic('https://app.test/api/save', 500, 1100)];
  const c = [consoleEntry('error', 'save failed', 1150)];
  return buildVerifyTrace(steps, t, c);
}

// G(!http.status_class(/api/, 5xx)) — "no server errors, ever".
const NO_5XX = globally(not(pred('http.status_class', ['/api/', '5xx'])));
// F(http.response(/api/save, 200)) — "the save eventually succeeds".
const SAVE_OK = eventually(pred('http.response', ['/api/save', '200']));

const BEHAVIOR = 'checkout/save-works';

// --- Asymmetric policy -------------------------------------------------------

test('approved violated formula overrides an LLM pass: failed, verdict_source monitor, witness present', () => {
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed', 'Looked fine.'));
  const sink = emitSink();
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), serverErrorTrace(), { emit: sink.emit });

  const out = merged.output as VerifyOut;
  const result = out.results[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.verdict_source, 'monitor');
  assert.equal(out.pass, false);
  assert.deepEqual(out.summary, { total: 1, passed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(merged.monitorForcedFailures, [BEHAVIOR]);

  const verdict = result.monitor?.[0];
  assert.ok(verdict);
  assert.equal(verdict.verdict, 'violated');
  assert.equal(verdict.status, 'approved');
  assert.equal(verdict.witness_step, 1);
  assert.match(verdict.witness_detail ?? '', /api\/save/);
  assert.equal(verdict.trace_length, 2);

  // Rationale keeps the LLM's text and appends the witness detail.
  assert.match(result.rationale ?? '', /^Looked fine\./);
  assert.match(result.rationale ?? '', /\[monitor\] Formula .* violated/);

  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, 'monitor:violation');
  assert.equal(sink.events[0].data.behavior, BEHAVIOR);

  // Exit-code policy: monitor-only failure.
  assert.equal(isMonitorOnlyFailure(out), true);
});

test('approved violated formula + LLM fail: concur, verdict_source monitor+llm, not monitor-only', () => {
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'failed', 'Save button broken.'));
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), serverErrorTrace());

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'failed');
  assert.equal(out.results[0].verdict_source, 'monitor+llm');
  assert.deepEqual(merged.monitorForcedFailures, []);
  assert.equal(isMonitorOnlyFailure(out), false);
});

test('satisfied approved formula never overturns an LLM fail: disagreement flagged instead', () => {
  // Trace where the save DID return 200 — SAVE_OK is satisfied.
  const steps = [step(0, { trafficRange: [0, 1], consoleRange: [0, 0] })];
  const trace = buildVerifyTrace(steps, [traffic('https://app.test/api/save', 200, 100)], []);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'failed', 'Confirmation page missing.'));
  const sink = emitSink();
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, SAVE_OK, 'approved')), trace, { emit: sink.emit });

  const out = merged.output as VerifyOut;
  const result = out.results[0];
  assert.equal(result.status, 'failed'); // LLM fail stands
  assert.equal(result.verdict_source, 'llm');
  assert.equal(result.monitor?.[0].verdict, 'satisfied');
  assert.equal(result.monitor?.[0].disagreement, true);
  assert.equal(out.pass, false);

  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, 'monitor:disagreement');
  assert.equal(isMonitorOnlyFailure(out), false);
});

test('satisfied approved formula + LLM pass: passed, verdict_source monitor+llm', () => {
  const steps = [step(0, { trafficRange: [0, 1], consoleRange: [0, 0] })];
  const trace = buildVerifyTrace(steps, [traffic('https://app.test/api/save', 200, 100)], []);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, SAVE_OK, 'approved')), trace);

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'passed');
  assert.equal(out.results[0].verdict_source, 'monitor+llm');
  assert.equal(out.results[0].monitor?.[0].disagreement, undefined);
  assert.equal(out.pass, true);
});

test('draft formula violated: shadow mode — advisory verdict attached, no status change, no events', () => {
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const sink = emitSink();
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'draft')), serverErrorTrace(), { emit: sink.emit });

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'passed');
  assert.equal(out.results[0].verdict_source, 'llm');
  assert.equal(out.results[0].monitor?.[0].verdict, 'violated');
  assert.equal(out.results[0].monitor?.[0].status, 'draft');
  assert.equal(out.pass, true);
  assert.deepEqual(merged.monitorForcedFailures, []);
  assert.equal(sink.events.length, 0);
  assert.equal(isMonitorOnlyFailure(out), false);
});

test('unevaluable predicate: verdict unevaluable, no status change', () => {
  // ax.role needs an AX snapshot + axBaseDir; neither is available here.
  const formula = eventually(pred('ax.role', ['button', 'Save']));
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, formula, 'approved')), serverErrorTrace());

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'passed');
  assert.equal(out.results[0].monitor?.[0].verdict, 'unevaluable');
  assert.equal(out.pass, true);
});

test('inconclusive verdict (prefix semantics, obligation never witnessed): no status change', () => {
  // F(http.request(/api/save)) over a trace that never issued the request:
  // http.request is a definite false on absence, so under prefix semantics
  // the unfulfilled F obligation is 'inconclusive' (the run may have ended
  // early), never 'violated'.
  const steps = [step(0, { trafficRange: [0, 1], consoleRange: [0, 0] })];
  const trace = buildVerifyTrace(steps, [traffic('https://app.test/api/other', 200, 100)], []);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const formula = eventually(pred('http.request', ['/api/save']));
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, formula, 'approved')), trace);

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'passed');
  assert.equal(out.results[0].verdict_source, 'llm');
  assert.equal(out.results[0].monitor?.[0].verdict, 'inconclusive');
  assert.equal(out.pass, true);
});

test('rejected formulas are not evaluated; no applicable formulas returns the input by reference', () => {
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));

  const rejectedOnly = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'rejected')), serverErrorTrace());
  assert.equal(rejectedOnly.output, output);
  assert.equal(rejectedOnly.verdictsAttached, 0);

  const otherBehavior = mergeMonitorVerdicts(output, formulasFile(formulaEntry('other/behavior', NO_5XX, 'approved')), serverErrorTrace());
  assert.equal(otherBehavior.output, output);
});

test('merge never mutates the input structured output', () => {
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed', 'Looked fine.'));
  const snapshot = JSON.stringify(output);
  mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), serverErrorTrace());
  assert.equal(JSON.stringify(output), snapshot);
});

test('behaviors without formulas are untouched; summary recomputed across the mix', () => {
  const output = verifyOutput(
    behaviorResult(BEHAVIOR, 'passed'),
    behaviorResult('other/untouched', 'passed'),
  );
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), serverErrorTrace());

  const out = merged.output as VerifyOut;
  assert.equal(out.results[1].monitor, undefined);
  assert.equal(out.results[1].verdict_source, undefined);
  assert.equal(out.results[1].status, 'passed');
  assert.deepEqual(out.summary, { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.equal(out.pass, false);
});

test('isMonitorOnlyFailure: mixed failures (any LLM-reported fail) are not monitor-only', () => {
  const output = verifyOutput(
    behaviorResult(BEHAVIOR, 'passed'),
    behaviorResult('other/llm-failed', 'failed'),
  );
  const merged = mergeMonitorVerdicts(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), serverErrorTrace());
  assert.equal(isMonitorOnlyFailure(merged.output), false);
  // And a fully-passing output is never monitor-only.
  assert.equal(isMonitorOnlyFailure(verifyOutput(behaviorResult(BEHAVIOR, 'passed'))), false);
});

test('malformed structured output (no results array) is returned untouched', () => {
  for (const bad of [undefined, null, 42, 'text', {}, { results: 'nope' }]) {
    const merged = mergeMonitorVerdicts(bad, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), serverErrorTrace());
    assert.equal(merged.output, bad);
    assert.equal(merged.verdictsAttached, 0);
  }
});

// --- Trace construction ------------------------------------------------------

test('buildVerifyTrace: step positions with index-slice event windows; final open range picks up trailing events', () => {
  const steps = [
    step(0, { trafficRange: [0, 1], consoleRange: [0, 0] }),
    // Final step: recorder's range end is still open ([1, 1]) at merge time.
    step(1, { trafficRange: [1, 1], consoleRange: [0, 0] }),
  ];
  const t = [
    traffic('https://app.test/a', 200, 100),
    traffic('https://app.test/b', 200, 1100),
    traffic('https://app.test/c', 500, 1200), // landed after endStep, before save()
  ];
  const c = [consoleEntry('error', 'boom', 1150)];

  const trace = buildVerifyTrace(steps, t, c);
  assert.equal(trace.length, 2);
  assert.equal(trace[0].events.length, 1);
  assert.equal(trace[1].events.length, 3); // b, c and the console error
  assert.ok(trace[0].step);
  // Events within a window are timestamp-sorted.
  assert.deepEqual(trace[1].events.map((e) => e.ts), [1100, 1150, 1200]);
});

test('buildVerifyTrace fallback: no steps -> event timeline; step predicates unevaluable, event formulas evaluable', () => {
  const t = [traffic('https://app.test/api/save', 500, 100)];
  const trace = buildVerifyTrace([], t, [consoleEntry('log', 'hi', 50)]);
  assert.equal(trace.length, 2); // one position per event
  assert.equal(trace[0].step, undefined);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const file = formulasFile(
    formulaEntry(BEHAVIOR, NO_5XX, 'approved', 'fml-ev'),
    formulaEntry(BEHAVIOR, globally(pred('page.url', ['/checkout'])), 'approved', 'fml-st'),
  );
  const merged = mergeMonitorVerdicts(output, file, trace);
  const out = merged.output as VerifyOut;
  const byId = new Map(out.results[0].monitor?.map((v) => [v.formula_id, v]));
  assert.equal(byId.get('fml-ev')?.verdict, 'violated'); // event formula still evaluable
  assert.equal(byId.get('fml-st')?.verdict, 'unevaluable'); // step predicate has no step data
  assert.equal(out.results[0].status, 'failed'); // the event violation still wins
});

// --- Runner boundary wrapper -------------------------------------------------

test('mergeMonitorVerdictsForRun: builds the trace from in-memory run data and merges', () => {
  const steps = [
    step(0, { action: 'goto', trafficRange: [0, 1], consoleRange: [0, 0] }),
    step(1, { trafficRange: [1, 1], consoleRange: [0, 0] }), // open final range
  ];
  const t = [traffic('https://app.test/api/session', 200, 100), traffic('https://app.test/api/save', 500, 1100)];
  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const sink = emitSink();

  const merged = mergeMonitorVerdictsForRun(output, formulasFile(formulaEntry(BEHAVIOR, NO_5XX, 'approved')), {
    steps,
    traffic: t,
    consoleLogs: [],
    emit: sink.emit,
  });

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'failed');
  assert.equal(out.results[0].verdict_source, 'monitor');
  assert.equal(out.results[0].monitor?.[0].witness_step, 1);
  assert.equal(sink.events[0]?.type, 'monitor:violation');
});

// --- Live dom.* probes end-to-end (SP-efp) -----------------------------------
//
// dom.* predicates never touch traffic/console/AX data — they read booleans
// recorded onto StepObservation.probes by live sampling (capture-agent.ts).
// These fixtures exercise the full pipeline the other way round from
// probe-plan.test.ts / predicates.test.ts: given a synthetic trace whose
// steps already carry recorded probe values, G(dom.visible(...)) merges into
// a deterministic verdict via the same asymmetric policy as every other
// predicate family.

test('SP-efp: F(dom.visible(#toast)) satisfied end-to-end via verdict-merge over recorded probes', () => {
  // F (not G) so the witnessed `true` at step 1 pins down 'satisfied' even
  // under prefix semantics (mergeMonitorVerdicts always evaluates with
  // traceComplete:false — see verdict-merge.ts's module docstring); a G over
  // a truncated prefix with no failing step is 'inconclusive', not
  // 'satisfied', since the run could still continue.
  const key = canonicalProbeKey('dom.visible', ['#toast']);
  const steps = [
    step(0, { action: 'goto', probes: { [key]: false } }),
    step(1, { probes: { [key]: true } }),
  ];
  const trace = buildVerifyTrace(steps, [], []);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const file = formulasFile(formulaEntry(BEHAVIOR, eventually(pred('dom.visible', ['#toast'])), 'approved'));
  const merged = mergeMonitorVerdicts(output, file, trace);

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'passed');
  assert.equal(out.results[0].verdict_source, 'monitor+llm');
  assert.equal(out.results[0].monitor?.[0].verdict, 'satisfied');
  assert.equal(out.results[0].monitor?.[0].witness_step, 1);
});

test('SP-efp: G(dom.visible(#toast)) violated end-to-end forces the behavior to failed', () => {
  const key = canonicalProbeKey('dom.visible', ['#toast']);
  const steps = [
    step(0, { action: 'goto', probes: { [key]: true } }),
    step(1, { probes: { [key]: false } }), // toast disappeared — G violated at step 1
  ];
  const trace = buildVerifyTrace(steps, [], []);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const file = formulasFile(formulaEntry(BEHAVIOR, globally(pred('dom.visible', ['#toast'])), 'approved'));
  const merged = mergeMonitorVerdicts(output, file, trace);

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'failed');
  assert.equal(out.results[0].verdict_source, 'monitor');
  assert.equal(out.results[0].monitor?.[0].verdict, 'violated');
  assert.equal(out.results[0].monitor?.[0].witness_step, 1);
  assert.deepEqual(merged.monitorForcedFailures, [BEHAVIOR]);
});

test('SP-efp: dom.* probe never sampled (no probes map on any step) is unevaluable, never affects status', () => {
  const steps = [step(0, { action: 'goto' }), step(1)]; // no `probes` field at all
  const trace = buildVerifyTrace(steps, [], []);

  const output = verifyOutput(behaviorResult(BEHAVIOR, 'passed'));
  const file = formulasFile(formulaEntry(BEHAVIOR, globally(pred('dom.visible', ['#toast'])), 'approved'));
  const merged = mergeMonitorVerdicts(output, file, trace);

  const out = merged.output as VerifyOut;
  assert.equal(out.results[0].status, 'passed');
  assert.equal(out.results[0].monitor?.[0].verdict, 'unevaluable');
});
