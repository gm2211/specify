import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgeItfTrace,
  bridgeApprovedSpecTrace,
  readPredicateBits,
  QuintSpecNotApprovedError,
  type QuintTraceScript,
} from './quint-bridge.js';
import type { ItfTrace, ItfState } from './quint-itf.js';
import type { QuintSpecsFile, QuintSpecStatus } from '../spec/quint-specs.js';

function trace(states: ItfState[]): ItfTrace {
  return { vars: [], states, meta: {} };
}

// ---------------------------------------------------------------------------
// readPredicateBits
// ---------------------------------------------------------------------------

test('readPredicateBits: reads an ITF map form', () => {
  const state: ItfState = { predicates: { map: [['http.response', true], ['page.url', false]] } };
  assert.deepEqual(readPredicateBits(state, 'predicates'), { 'http.response': true, 'page.url': false });
});

test('readPredicateBits: reads a plain record form', () => {
  const state: ItfState = { predicates: { 'http.response': true } };
  assert.deepEqual(readPredicateBits(state, 'predicates'), { 'http.response': true });
});

test('readPredicateBits: skips non-boolean values', () => {
  const state: ItfState = { predicates: { map: [['x', 'nope' as unknown as boolean], ['y', true]] } };
  assert.deepEqual(readPredicateBits(state, 'predicates'), { y: true });
});

test('readPredicateBits: absent field yields empty', () => {
  assert.deepEqual(readPredicateBits({}, 'predicates'), {});
});

// ---------------------------------------------------------------------------
// bridgeItfTrace
// ---------------------------------------------------------------------------

test('bridgeItfTrace: entry navigates to the initial state url', () => {
  const script = bridgeItfTrace(trace([{ url: '/login' }]), 'auth/login');
  assert.equal(script.entry.action, 'browser_goto');
  assert.equal(script.entry.value, '/login');
  assert.equal(script.steps.length, 0);
  assert.equal(script.source, 'quint');
  assert.equal(script.id, 'auth/login~quint~0');
});

test('bridgeItfTrace: each non-initial state becomes a step keyed on its producing action', () => {
  const script = bridgeItfTrace(
    trace([
      { url: '/login', action: 'init' },
      { url: '/login', action: 'browser_fill', selector: '#email', value: 'a@b.c' },
      { url: '/dashboard', action: 'browser_click', selector: '#submit' },
    ]),
    'auth/login',
  );
  assert.equal(script.steps.length, 2);
  assert.equal(script.steps[0].action, 'browser_fill');
  assert.equal(script.steps[0].selector, '#email');
  assert.equal(script.steps[0].value, 'a@b.c');
  assert.equal(script.steps[0].index, 0);
  assert.equal(script.steps[1].action, 'browser_click');
  assert.equal(script.steps[1].selector, '#submit');
  assert.equal(script.steps[1].index, 1);
});

test('bridgeItfTrace: final state url + grounded predicates become assertions', () => {
  const script = bridgeItfTrace(
    trace([
      { url: '/login' },
      { url: '/dashboard', action: 'browser_click', predicates: { map: [['page.url', true]] } },
    ]),
    'auth/login',
  );
  const urlA = script.assertions.find((a) => a.kind === 'url-template');
  assert.ok(urlA && urlA.kind === 'url-template');
  assert.equal(urlA.urlTemplate, '/dashboard');
  const predA = script.assertions.find((a) => a.kind === 'predicate');
  assert.ok(predA && predA.kind === 'predicate');
  assert.deepEqual(predA.predicates, { 'page.url': true });
});

test('bridgeItfTrace: ungrounded predicate names are reported, not asserted', () => {
  const script = bridgeItfTrace(
    trace([
      { url: '/login', predicates: { map: [['not.a.real.predicate', true]] } },
      { url: '/dashboard', action: 'browser_click', predicates: { map: [['page.url', true], ['bogus.pred', false]] } },
    ]),
    'auth/login',
  );
  assert.deepEqual(script.ungroundedPredicates, ['bogus.pred', 'not.a.real.predicate']);
  // Only the grounded page.url survives into the final-state assertion.
  const predA = script.assertions.find((a) => a.kind === 'predicate');
  assert.ok(predA && predA.kind === 'predicate');
  assert.deepEqual(predA.predicates, { 'page.url': true });
});

test('bridgeItfTrace: renders deterministic Playwright reusing trace-compiler lowering', () => {
  const script = bridgeItfTrace(
    trace([
      { url: '/login' },
      { url: '/login', action: 'browser_fill', selector: '#email', value: 'x' },
      { url: '/dashboard', action: 'browser_click', selector: '#go' },
    ]),
    'auth/login',
  );
  const pw = script.playwright;
  assert.ok(pw.includes("await page.goto('/login')"));
  assert.ok(pw.includes("await page.fill('#email', 'x')"));
  assert.ok(pw.includes("await page.click('#go')"));
  assert.ok(pw.includes('toHaveURL'));
  // Determinism: same input → identical render.
  const again = bridgeItfTrace(
    trace([
      { url: '/login' },
      { url: '/login', action: 'browser_fill', selector: '#email', value: 'x' },
      { url: '/dashboard', action: 'browser_click', selector: '#go' },
    ]),
    'auth/login',
  );
  assert.equal(again.playwright, pw);
});

test('bridgeItfTrace: clear-cookies step pulls the context fixture into the render', () => {
  const script = bridgeItfTrace(
    trace([{ url: '/dashboard' }, { url: '/dashboard', action: 'browser_clear_cookies' }]),
    'auth/session',
  );
  assert.ok(script.playwright.includes('{ page, context }'));
  assert.ok(script.playwright.includes('await context.clearCookies();'));
});

test('bridgeItfTrace: ungrounded predicates appear as a warning comment in the render', () => {
  const script: QuintTraceScript = bridgeItfTrace(
    trace([{ url: '/x', predicates: { map: [['made.up', true]] } }]),
    'auth/x',
  );
  assert.ok(script.playwright.includes('ungrounded predicate'));
});

test('bridgeItfTrace: empty trace yields an entry-only script, no crash', () => {
  const script = bridgeItfTrace(trace([]), 'auth/none');
  assert.equal(script.steps.length, 0);
  assert.equal(script.entry.value, '/');
});

// ---------------------------------------------------------------------------
// bridgeApprovedSpecTrace — the structural review gate
// ---------------------------------------------------------------------------

function storeWith(status: QuintSpecStatus): QuintSpecsFile {
  return {
    version: 1,
    specs: [
      {
        id: 'qnt-0123456789',
        flow: 'auth/login',
        description_hash: 'sha256:x',
        spec_text: 'module auth {}',
        predicates_used: ['page.url'],
        status,
        provenance: { drafted_by: 'llm', drafted_at: '2026-07-18T00:00:00Z' },
      },
    ],
  };
}

test('bridgeApprovedSpecTrace: refuses a draft spec — the gate is structural', () => {
  assert.throws(
    () => bridgeApprovedSpecTrace(storeWith('draft'), 'qnt-0123456789', trace([{ url: '/login' }])),
    (err: unknown) => err instanceof QuintSpecNotApprovedError && err.message.includes('"draft"'),
  );
});

test('bridgeApprovedSpecTrace: refuses a rejected spec', () => {
  assert.throws(
    () => bridgeApprovedSpecTrace(storeWith('rejected'), 'qnt-0123456789', trace([{ url: '/login' }])),
    QuintSpecNotApprovedError,
  );
});

test('bridgeApprovedSpecTrace: refuses an unknown spec id', () => {
  assert.throws(
    () => bridgeApprovedSpecTrace(storeWith('approved'), 'qnt-missing', trace([{ url: '/login' }])),
    (err: unknown) => err instanceof QuintSpecNotApprovedError && err.message.includes('not found'),
  );
});

test('bridgeApprovedSpecTrace: an approved spec bridges, carrying flow + id provenance', () => {
  const script = bridgeApprovedSpecTrace(
    storeWith('approved'),
    'qnt-0123456789',
    trace([{ url: '/login' }, { url: '/dashboard', action: 'browser_click', selector: '#go' }]),
  );
  assert.equal(script.flow, 'auth/login');
  assert.equal(script.id, 'auth/login~qnt-0123456789~quint~0');
  assert.equal(script.steps.length, 1);
});
