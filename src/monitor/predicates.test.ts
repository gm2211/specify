import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { CapturedConsoleEntry, CapturedTraffic } from '../capture/types.js';
import type { StepObservation } from '../agent/observation.js';
import { evaluate } from './evaluate.js';
import { and, eventually, globally, not, or, pred } from './formula.js';
import type { Trace, TraceState } from './trace.js';
import {
  consoleTraceEvent,
  createRegistryEvaluator,
  escapeRegExp,
  generatePredicateDocs,
  httpTraceEvent,
  parseAriaSnapshot,
  predicateRegistry,
  type PredicateContext,
} from './predicates.js';

// --- Fixture builders ----------------------------------------------------------

function traffic(overrides: Partial<CapturedTraffic> = {}): CapturedTraffic {
  return {
    url: 'https://example.com/api/session',
    method: 'GET',
    postData: null,
    status: 200,
    contentType: 'application/json',
    ts: 1000,
    responseBody: '{"user":{"id":42},"ok":true}',
    ...overrides,
  };
}

function consoleEntry(overrides: Partial<CapturedConsoleEntry> = {}): CapturedConsoleEntry {
  return { type: 'log', text: 'hello', ts: 1000, ...overrides };
}

function stepObservation(overrides: Partial<StepObservation> = {}): StepObservation {
  return {
    step: 0,
    action: 'click',
    success: true,
    urlBefore: 'https://example.com/',
    urlAfter: 'https://example.com/checkout',
    title: 'Checkout',
    tsStart: 1000,
    tsEnd: 1001,
    ax: { error: 'no ax captured in fixture' },
    trafficRange: [0, 0],
    consoleRange: [0, 0],
    ...overrides,
  };
}

function state(overrides: Partial<TraceState> = {}): TraceState {
  return { index: 0, events: [], ...overrides };
}

function evalOne(name: string, args: string[], st: TraceState, ctx?: Partial<PredicateContext>) {
  const trace: Trace = ctx?.trace ?? [st];
  const evaluator = createRegistryEvaluator(trace, { axBaseDir: ctx?.axBaseDir });
  return evaluator.eval({ name, args }, st);
}

// ================================================================================
// http.request
// ================================================================================

test('http.request: positive — matching method + url', () => {
  const st = state({ events: [httpTraceEvent(traffic({ method: 'GET', url: 'https://x.test/api/session' }))] });
  assert.equal(evalOne('http.request', ['GET', '/api/session'], st), true);
});

test('http.request: negative — no matching request', () => {
  const st = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/other' }))] });
  assert.equal(evalOne('http.request', ['/api/session'], st), false);
});

test('http.request: unevaluable — malformed regex', () => {
  const st = state({ events: [httpTraceEvent(traffic())] });
  assert.equal(evalOne('http.request', ['('], st), 'unevaluable');
});

// ================================================================================
// http.response
// ================================================================================

test('http.response: positive — exact status match', () => {
  const st = state({ events: [httpTraceEvent(traffic({ status: 200 }))] });
  assert.equal(evalOne('http.response', ['/api/session', '200'], st), true);
});

test('http.response: negative — matching url, different status', () => {
  const st = state({ events: [httpTraceEvent(traffic({ status: 404 }))] });
  assert.equal(evalOne('http.response', ['/api/session', '200'], st), false);
});

test('http.response: unevaluable — no matching-url response observed', () => {
  const st = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/other' }))] });
  assert.equal(evalOne('http.response', ['/api/session', '200'], st), 'unevaluable');
});

// ================================================================================
// http.status_class
// ================================================================================

test('http.status_class: positive — 2xx', () => {
  const st = state({ events: [httpTraceEvent(traffic({ status: 201 }))] });
  assert.equal(evalOne('http.status_class', ['/api/session', '2xx'], st), true);
});

test('http.status_class: negative — 5xx observed, asked for 2xx', () => {
  const st = state({ events: [httpTraceEvent(traffic({ status: 500 }))] });
  assert.equal(evalOne('http.status_class', ['/api/session', '2xx'], st), false);
});

test('http.status_class: unevaluable — no matching url', () => {
  const st = state({ events: [] });
  assert.equal(evalOne('http.status_class', ['/api/session', '2xx'], st), 'unevaluable');
});

// ================================================================================
// http.response_json
// ================================================================================

test('http.response_json: positive — path resolves and equals value', () => {
  const st = state({ events: [httpTraceEvent(traffic({ responseBody: '{"user":{"id":42}}' }))] });
  assert.equal(evalOne('http.response_json', ['/api/session', 'user.id', '42'], st), true);
});

test('http.response_json: negative — parses, path missing (documented asymmetry)', () => {
  const st = state({ events: [httpTraceEvent(traffic({ responseBody: '{"ok":true}' }))] });
  assert.equal(evalOne('http.response_json', ['/api/session', 'user.id', '42'], st), false);
});

test('http.response_json: unevaluable — body absent', () => {
  const st = state({ events: [httpTraceEvent(traffic({ responseBody: null }))] });
  assert.equal(evalOne('http.response_json', ['/api/session', 'user.id', '42'], st), 'unevaluable');
});

test('http.response_json: unevaluable — body unparseable as JSON', () => {
  const st = state({ events: [httpTraceEvent(traffic({ responseBody: 'not json' }))] });
  assert.equal(evalOne('http.response_json', ['/api/session', 'user.id', '42'], st), 'unevaluable');
});

// ================================================================================
// http.body_matches / http.post_data_matches
// ================================================================================

test('http.body_matches: positive/negative/unevaluable', () => {
  const withBody = state({ events: [httpTraceEvent(traffic({ responseBody: '{"status":"ok"}' }))] });
  assert.equal(evalOne('http.body_matches', ['/api/session', '"status":"ok"'], withBody), true);
  assert.equal(evalOne('http.body_matches', ['/api/session', '"status":"fail"'], withBody), false);

  const noBody = state({ events: [httpTraceEvent(traffic({ responseBody: null }))] });
  assert.equal(evalOne('http.body_matches', ['/api/session', 'x'], noBody), 'unevaluable');
});

test('http.post_data_matches: positive/negative/unevaluable', () => {
  const withData = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/checkout', postData: '{"cardType":"visa"}' }))] });
  assert.equal(evalOne('http.post_data_matches', ['/api/checkout', 'cardType'], withData), true);
  assert.equal(evalOne('http.post_data_matches', ['/api/checkout', 'amex'], withData), false);

  const noData = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/checkout', postData: null }))] });
  assert.equal(evalOne('http.post_data_matches', ['/api/checkout', 'cardType'], noData), 'unevaluable');
});

// ================================================================================
// http.no_request
// ================================================================================

test('http.no_request: positive — nothing matched', () => {
  const st = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/session' }))] });
  assert.equal(evalOne('http.no_request', ['/api/legacy'], st), true);
});

test('http.no_request: negative — a matching request occurred', () => {
  const st = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/legacy' }))] });
  assert.equal(evalOne('http.no_request', ['/api/legacy'], st), false);
});

test('http.no_request: unevaluable — malformed pattern', () => {
  const st = state({ events: [] });
  assert.equal(evalOne('http.no_request', ['('], st), 'unevaluable');
});

// ================================================================================
// console.error / console.message
// ================================================================================

test('console.error: positive/negative/unevaluable', () => {
  const st = state({ events: [consoleTraceEvent(consoleEntry({ type: 'error', text: 'Uncaught TypeError: boom' }))] });
  assert.equal(evalOne('console.error', [], st), true);
  assert.equal(evalOne('console.error', ['TypeError'], st), true);
  assert.equal(evalOne('console.error', ['RangeError'], st), false);
  assert.equal(evalOne('console.error', ['('], st), 'unevaluable');
});

test('console.error: negative — only non-error entries', () => {
  const st = state({ events: [consoleTraceEvent(consoleEntry({ type: 'log' }))] });
  assert.equal(evalOne('console.error', [], st), false);
});

test('console.message: positive/negative/unevaluable', () => {
  const st = state({ events: [consoleTraceEvent(consoleEntry({ type: 'warn', text: 'deprecated API' }))] });
  assert.equal(evalOne('console.message', ['warn', 'deprecated'], st), true);
  assert.equal(evalOne('console.message', ['warn', 'removed'], st), false);
  assert.equal(evalOne('console.message', ['warn', '('], st), 'unevaluable');
});

// ================================================================================
// step.action
// ================================================================================

test('step.action: positive — type only', () => {
  const st = state({ step: stepObservation({ action: 'click' }) });
  assert.equal(evalOne('step.action', ['click'], st), true);
});

test('step.action: positive — type + selector pattern', () => {
  const st = state({ step: stepObservation({ action: 'fill', args: { selector: '#email' } }) });
  assert.equal(evalOne('step.action', ['fill', '#email'], st), true);
});

test('step.action: negative — different action type', () => {
  const st = state({ step: stepObservation({ action: 'click' }) });
  assert.equal(evalOne('step.action', ['fill'], st), false);
});

test('step.action: unevaluable — no step observation on this position', () => {
  const st = state({ step: undefined });
  assert.equal(evalOne('step.action', ['click'], st), 'unevaluable');
});

test('step.action: unevaluable — selectorPattern requested but no selector recorded', () => {
  const st = state({ step: stepObservation({ action: 'click', args: undefined }) });
  assert.equal(evalOne('step.action', ['click', '#login'], st), 'unevaluable');
});

// ================================================================================
// page.url / page.title
// ================================================================================

test('page.url: positive/negative/unevaluable', () => {
  const st = state({ step: stepObservation({ urlAfter: 'https://x.test/checkout/confirmation' }) });
  assert.equal(evalOne('page.url', ['/confirmation$'], st), true);
  assert.equal(evalOne('page.url', ['/cart$'], st), false);
  assert.equal(evalOne('page.url', ['/confirmation$'], state({ step: undefined })), 'unevaluable');
});

test('page.title: positive/negative/unevaluable (missing title field)', () => {
  const st = state({ step: stepObservation({ title: 'Order Confirmed' }) });
  assert.equal(evalOne('page.title', ['^Order'], st), true);
  assert.equal(evalOne('page.title', ['^Cart'], st), false);

  const noTitle = state({ step: stepObservation({ title: undefined }) });
  assert.equal(evalOne('page.title', ['^Order'], noTitle), 'unevaluable');
});

// ================================================================================
// ax.role
// ================================================================================

function withAxFile(dir: string, filename: string, yamlText: string): void {
  const axDir = path.join(dir, 'observations', 'ax');
  fs.mkdirSync(axDir, { recursive: true });
  fs.writeFileSync(path.join(axDir, filename), yamlText, 'utf-8');
}

test('ax.role: positive — role + name match in snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-test-'));
  withAxFile(dir, '000.yaml', '- generic:\n  - heading "Checkout" [level=1]\n  - button "Place order"\n');
  const st = state({
    index: 0,
    step: stepObservation({ ax: { file: 'observations/ax/000.yaml', digest: 'abc' } }),
  });
  const trace: Trace = [st];
  assert.equal(evalOne('ax.role', ['button', 'Place order'], st, { trace, axBaseDir: dir }), true);
  assert.equal(evalOne('ax.role', ['heading', 'Checkout'], st, { trace, axBaseDir: dir }), true);
});

test('ax.role: negative — role present but no matching node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-test-'));
  withAxFile(dir, '000.yaml', '- generic:\n  - button "Cancel"\n');
  const st = state({ step: stepObservation({ ax: { file: 'observations/ax/000.yaml', digest: 'abc' } }) });
  const trace: Trace = [st];
  assert.equal(evalOne('ax.role', ['button', 'Place order'], st, { trace, axBaseDir: dir }), false);
});

test('ax.role: unevaluable — ax observation is {error}', () => {
  const st = state({ step: stepObservation({ ax: { error: 'ariaSnapshot timed out' } }) });
  const trace: Trace = [st];
  assert.equal(evalOne('ax.role', ['button'], st, { trace, axBaseDir: '/nonexistent' }), 'unevaluable');
});

test('ax.role: resolves {unchanged} chain backward to the last written file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-test-'));
  withAxFile(dir, '000.yaml', '- generic:\n  - button "Place order"\n');
  const st0 = state({ index: 0, step: stepObservation({ step: 0, ax: { file: 'observations/ax/000.yaml', digest: 'abc' } }) });
  const st1 = state({ index: 1, step: stepObservation({ step: 1, ax: { unchanged: true, digest: 'abc' } }) });
  const trace: Trace = [st0, st1];
  assert.equal(evalOne('ax.role', ['button', 'Place order'], st1, { trace, axBaseDir: dir }), true);
});

test('ax.role: unevaluable — no step observation at position', () => {
  const st = state({ step: undefined });
  assert.equal(evalOne('ax.role', ['button'], st, { trace: [st], axBaseDir: '/tmp' }), 'unevaluable');
});

test('parseAriaSnapshot: tolerant matcher extracts role/name pairs', () => {
  const entries = parseAriaSnapshot('- generic:\n  - heading "Checkout" [level=1]\n  - list:\n    - listitem "Item 1"\n');
  assert.ok(entries.some((e) => e.role === 'heading' && e.name === 'Checkout'));
  assert.ok(entries.some((e) => e.role === 'listitem' && e.name === 'Item 1'));
});

// ================================================================================
// escapeRegExp
// ================================================================================

test('escapeRegExp: escapes regex metacharacters for literal matching', () => {
  const st = state({ events: [httpTraceEvent(traffic({ url: 'https://x.test/api/v1.0/session?x=1' }))] });
  const escaped = escapeRegExp('/api/v1.0/session?x=1');
  assert.equal(evalOne('http.request', [escaped], st), true);
});

// ================================================================================
// Unknown predicate name
// ================================================================================

test('unknown predicate name: unevaluable, never throws', () => {
  const st = state({ events: [] });
  assert.equal(evalOne('nonexistent.predicate', [], st), 'unevaluable');
});

// ================================================================================
// Integration: registry wired into evaluateFormula over a synthetic trace
// ================================================================================

test('integration: G(status_class(api,2xx) or console.error absent) over a synthetic trace', () => {
  const okStep: TraceState = state({
    index: 0,
    events: [httpTraceEvent(traffic({ url: 'https://x.test/api/a', status: 200 }))],
  });
  const errorButHandledStep: TraceState = state({
    index: 1,
    events: [
      httpTraceEvent(traffic({ url: 'https://x.test/api/b', status: 200 })),
    ],
  });
  const trace: Trace = [okStep, errorButHandledStep];

  const formula = globally(
    or(pred('http.status_class', ['/api/', '2xx']), not(pred('console.error'))),
  );

  const evaluator = createRegistryEvaluator(trace);
  const result = evaluate(formula, trace, evaluator, { traceComplete: true });
  assert.equal(result.verdict, 'satisfied');
});

test('integration: violated when a 5xx occurs alongside a console error (both disjuncts false)', () => {
  const badStep: TraceState = state({
    index: 0,
    events: [
      httpTraceEvent(traffic({ url: 'https://x.test/api/a', status: 500 })),
      consoleTraceEvent(consoleEntry({ type: 'error', text: 'boom' })),
    ],
  });
  const trace: Trace = [badStep];
  const formula = globally(
    or(pred('http.status_class', ['/api/', '2xx']), not(pred('console.error'))),
  );
  const evaluator = createRegistryEvaluator(trace);
  const result = evaluate(formula, trace, evaluator, { traceComplete: true });
  assert.equal(result.verdict, 'violated');
  assert.equal(result.witnessStep, 0);
});

test('integration: F(page.url(confirmation)) is satisfied once the URL is reached', () => {
  const s0 = state({ index: 0, step: stepObservation({ step: 0, urlAfter: 'https://x.test/cart' }) });
  const s1 = state({ index: 1, step: stepObservation({ step: 1, urlAfter: 'https://x.test/checkout/confirmation' }) });
  const trace: Trace = [s0, s1];
  const evaluator = createRegistryEvaluator(trace);
  const result = evaluate(eventually(pred('page.url', ['/confirmation$'])), trace, evaluator, {
    traceComplete: true,
  });
  assert.equal(result.verdict, 'satisfied');
  assert.equal(result.witnessStep, 1);
});

test('integration: and(step predicate, event predicate) unevaluable propagates per 4-valued rules', () => {
  const s0 = state({ index: 0, step: undefined, events: [] });
  const trace: Trace = [s0];
  const evaluator = createRegistryEvaluator(trace);
  const result = evaluate(and(pred('page.url', ['/x']), pred('http.no_request', ['/y'])), trace, evaluator, {
    traceComplete: true,
  });
  // page.url is unevaluable (no step); http.no_request is a definite `true` (nothing matched).
  // AND precedence: violated > unevaluable > inconclusive > satisfied -> unevaluable wins.
  assert.equal(result.verdict, 'unevaluable');
});

// ================================================================================
// Docs generator
// ================================================================================

test('generatePredicateDocs: stable, deterministic, covers every registered predicate', () => {
  const doc1 = generatePredicateDocs();
  const doc2 = generatePredicateDocs();
  assert.equal(doc1, doc2);
  for (const name of Object.keys(predicateRegistry)) {
    assert.ok(doc1.includes(`\`${name}\``), `docs missing predicate ${name}`);
  }
  assert.ok(doc1.startsWith('# Predicate Reference'));
});
