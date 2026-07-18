import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeItfValue, parseItfTrace, parseItfJson, MAX_ITF_DEPTH, type ItfMap } from './quint-itf.js';

// ---------------------------------------------------------------------------
// decodeItfValue
// ---------------------------------------------------------------------------

test('decodeItfValue: passes through primitives', () => {
  const errs: string[] = [];
  const onErr = (m: string): void => void errs.push(m);
  assert.equal(decodeItfValue('hi', onErr), 'hi');
  assert.equal(decodeItfValue(true, onErr), true);
  assert.equal(decodeItfValue(3, onErr), 3);
  assert.equal(decodeItfValue(null, onErr), null);
  assert.deepEqual(errs, []);
});

test('decodeItfValue: #bigint small values become numbers, huge stay strings', () => {
  const onErr = (): void => {};
  assert.equal(decodeItfValue({ '#bigint': '42' }, onErr), 42);
  assert.equal(decodeItfValue({ '#bigint': '-7' }, onErr), -7);
  // Beyond MAX_SAFE_INTEGER — kept as exact string.
  assert.equal(decodeItfValue({ '#bigint': '99999999999999999999' }, onErr), '99999999999999999999');
});

test('decodeItfValue: #set and #tup decode to arrays, recursively', () => {
  const onErr = (): void => {};
  assert.deepEqual(decodeItfValue({ '#set': [1, { '#bigint': '2' }] }, onErr), [1, 2]);
  assert.deepEqual(decodeItfValue({ '#tup': ['a', 'b'] }, onErr), ['a', 'b']);
});

test('decodeItfValue: #map decodes to ordered pair list', () => {
  const onErr = (): void => {};
  const decoded = decodeItfValue(
    { '#map': [['http.response', true], ['page.url', false]] },
    onErr,
  ) as ItfMap;
  assert.deepEqual(decoded.map, [['http.response', true], ['page.url', false]]);
});

test('decodeItfValue: #unserializable surfaces the sentinel, not a crash', () => {
  const onErr = (): void => {};
  assert.deepEqual(decodeItfValue({ '#unserializable': '1 to Nat' }, onErr), { unserializable: '1 to Nat' });
});

test('decodeItfValue: nested #meta inside a record is stripped', () => {
  const onErr = (): void => {};
  const decoded = decodeItfValue({ '#meta': { index: 3 }, url: '/x' }, onErr) as Record<string, unknown>;
  assert.deepEqual(decoded, { url: '/x' });
});

test('decodeItfValue: malformed #set reports an error and yields empty array', () => {
  const errs: string[] = [];
  const onErr = (m: string): void => void errs.push(m);
  assert.deepEqual(decodeItfValue({ '#set': 'nope' }, onErr), []);
  assert.equal(errs.length, 1);
});

test('decodeItfValue: nesting beyond the depth cap is a structured error, not a stack overflow', () => {
  // Build a #tup chain nested well past the cap — deep enough that unbounded
  // recursion would overflow the stack, so this test is a real regression guard.
  let value: unknown = 'leaf';
  const depth = MAX_ITF_DEPTH * 100;
  for (let i = 0; i < depth; i++) value = { '#tup': [value] };
  const errs: string[] = [];
  const decoded = decodeItfValue(value, (m) => void errs.push(m));
  // The over-deep subtree is dropped as null; the cap is reported.
  assert.ok(errs.some((e) => e.includes(`maximum depth of ${MAX_ITF_DEPTH}`)));
  assert.ok(Array.isArray(decoded)); // outermost #tup still decodes
});

test('decodeItfValue: nesting under the cap decodes fully with no errors', () => {
  let value: unknown = 'leaf';
  for (let i = 0; i < MAX_ITF_DEPTH - 2; i++) value = { '#tup': [value] };
  const errs: string[] = [];
  decodeItfValue(value, (m) => void errs.push(m));
  assert.deepEqual(errs, []);
});

// ---------------------------------------------------------------------------
// parseItfTrace
// ---------------------------------------------------------------------------

test('parseItfTrace: parses a well-formed document', () => {
  const doc = {
    '#meta': { format: 'ITF', source: 'auth.qnt' },
    vars: ['url', 'action'],
    states: [
      { '#meta': { index: 0 }, url: '/login', action: 'init', predicates: { '#map': [['page.url', true]] } },
      { '#meta': { index: 1 }, url: '/dashboard', action: 'browser_click', predicates: { '#map': [['page.url', true]] } },
    ],
  };
  const { trace, errors } = parseItfTrace(doc);
  assert.deepEqual(errors, []);
  assert.deepEqual(trace.vars, ['url', 'action']);
  assert.equal(trace.states.length, 2);
  assert.equal(trace.states[0].url, '/login');
  assert.equal(trace.states[1].action, 'browser_click');
  // The per-state #meta was stripped.
  assert.equal('#meta' in trace.states[0], false);
  assert.equal(trace.meta.source, 'auth.qnt');
});

test('parseItfTrace: non-object root is the one hard failure', () => {
  const { trace, errors } = parseItfTrace([1, 2, 3]);
  assert.equal(trace.states.length, 0);
  assert.equal(errors.length, 1);
});

test('parseItfTrace: missing states array reports an error, empty trace', () => {
  const { trace, errors } = parseItfTrace({ vars: ['x'] });
  assert.equal(trace.states.length, 0);
  assert.ok(errors.some((e) => e.includes('states')));
});

test('parseItfTrace: a malformed state is skipped with an error, others survive', () => {
  const { trace, errors } = parseItfTrace({
    states: [{ url: '/a' }, 42, { url: '/b' }],
  });
  assert.equal(trace.states.length, 2);
  assert.equal(trace.states[0].url, '/a');
  assert.equal(trace.states[1].url, '/b');
  assert.ok(errors.some((e) => e.includes('state 1')));
});

// ---------------------------------------------------------------------------
// parseItfJson
// ---------------------------------------------------------------------------

test('parseItfJson: invalid JSON is a reported error, not a throw', () => {
  const { trace, errors } = parseItfJson('{ not json');
  assert.equal(trace.states.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('not valid JSON'));
});

test('parseItfJson: round-trips a real document', () => {
  const text = JSON.stringify({ vars: ['url'], states: [{ url: '/home' }] });
  const { trace, errors } = parseItfJson(text);
  assert.deepEqual(errors, []);
  assert.equal(trace.states[0].url, '/home');
});
