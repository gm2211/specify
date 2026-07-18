import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { BehaviorResult } from '../spec/types.js';
import { ExitCode } from '../cli/exit-codes.js';
import {
  SCRIPTED_METHOD,
  diffCrossCheck,
  partitionScriptedResults,
  scriptedModeExitCode,
  testsToBehaviorResults,
  untestedBehaviorResults,
} from './scripted-runner.js';
import type { FlatTestResult } from './test-runner.js';

// ---------------------------------------------------------------------------
// testsToBehaviorResults — title mapping to BehaviorResult[]
// ---------------------------------------------------------------------------

test('testsToBehaviorResults: maps a passed test title to a passed BehaviorResult', () => {
  const tests: FlatTestResult[] = [
    {
      title: 'checkout/apply-coupon: applying a valid coupon reduces the total',
      behaviorId: 'checkout/apply-coupon',
      status: 'passed',
    },
  ];
  const results = testsToBehaviorResults(tests);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'checkout/apply-coupon');
  assert.equal(results[0].status, 'passed');
  assert.equal(results[0].method, SCRIPTED_METHOD);
  assert.equal(results[0].description, 'applying a valid coupon reduces the total');
});

test('testsToBehaviorResults: maps a failed test title to a failed BehaviorResult with error evidence', () => {
  const tests: FlatTestResult[] = [
    {
      title: 'checkout/free-shipping: orders over $50 ship free',
      behaviorId: 'checkout/free-shipping',
      status: 'failed',
      error: 'expect(locator).toBeVisible() failed',
    },
  ];
  const results = testsToBehaviorResults(tests);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
  assert.ok(results[0].evidence?.[0]?.content.includes('expect(locator).toBeVisible() failed'));
});

test('testsToBehaviorResults: drops tests whose title has no parseable behavior id', () => {
  const tests: FlatTestResult[] = [
    { title: 'a random test with no contract prefix', status: 'passed' },
  ];
  assert.deepEqual(testsToBehaviorResults(tests), []);
});

test('testsToBehaviorResults: a failure anywhere in the group wins over a pass for the same behavior id', () => {
  const tests: FlatTestResult[] = [
    { title: 'checkout/apply-coupon: applying a valid coupon reduces the total', behaviorId: 'checkout/apply-coupon', status: 'passed' },
    { title: 'checkout/apply-coupon: applying a valid coupon reduces the total', behaviorId: 'checkout/apply-coupon', status: 'failed', error: 'flaked on webkit' },
  ];
  const results = testsToBehaviorResults(tests);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
});

// ---------------------------------------------------------------------------
// untestedBehaviorResults — spec behaviors with no matching generated test
// ---------------------------------------------------------------------------

test('untestedBehaviorResults: behaviors with no matching test are skipped with an "untested:" rationale', () => {
  const spec = {
    version: '2' as const,
    name: 'demo',
    target: { type: 'web' as const, url: 'http://localhost' },
    areas: [
      {
        id: 'checkout',
        name: 'Checkout',
        behaviors: [
          { id: 'apply-coupon', description: 'applying a valid coupon reduces the total' },
          { id: 'free-shipping', description: 'orders over $50 ship free' },
        ],
      },
    ],
  };
  const matched = new Set(['checkout/apply-coupon']);
  const results = untestedBehaviorResults(spec, matched);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'checkout/free-shipping');
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].rationale ?? '', /^untested:/);
});

// ---------------------------------------------------------------------------
// partitionScriptedResults — auto-mode partitioning
// ---------------------------------------------------------------------------

test('partitionScriptedResults: passed behaviors stay, failed + untested (skipped) escalate', () => {
  const results: BehaviorResult[] = [
    { id: 'a/1', description: 'x', status: 'passed', method: SCRIPTED_METHOD },
    { id: 'a/2', description: 'y', status: 'failed', method: SCRIPTED_METHOD },
    { id: 'a/3', description: 'z', status: 'skipped', method: SCRIPTED_METHOD, rationale: 'untested: no generated test matched this behavior id' },
  ];
  const { passed, escalate } = partitionScriptedResults(results);
  assert.deepEqual(passed.map((r) => r.id), ['a/1']);
  assert.deepEqual(escalate.map((r) => r.id), ['a/2', 'a/3']);
});

// ---------------------------------------------------------------------------
// diffCrossCheck — agreement matrix
// ---------------------------------------------------------------------------

test('diffCrossCheck: agent passed + test passed → agreement true', () => {
  const agent: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed' }];
  const scripted: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed', method: SCRIPTED_METHOD }];
  const diff = diffCrossCheck(agent, scripted);
  assert.deepEqual(diff, [{ id: 'a/1', agentStatus: 'passed', testStatus: 'passed', agreement: true }]);
});

test('diffCrossCheck: agent failed + test failed → agreement true', () => {
  const agent: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'failed' }];
  const scripted: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'failed', method: SCRIPTED_METHOD }];
  const diff = diffCrossCheck(agent, scripted);
  assert.equal(diff[0].agreement, true);
});

test('diffCrossCheck: agent passed + test failed → mismatch', () => {
  const agent: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed' }];
  const scripted: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'failed', method: SCRIPTED_METHOD }];
  const diff = diffCrossCheck(agent, scripted);
  assert.deepEqual(diff, [{ id: 'a/1', agentStatus: 'passed', testStatus: 'failed', agreement: false }]);
});

test('diffCrossCheck: agent failed + test passed → mismatch', () => {
  const agent: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'failed' }];
  const scripted: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed', method: SCRIPTED_METHOD }];
  const diff = diffCrossCheck(agent, scripted);
  assert.equal(diff[0].agreement, false);
});

test('diffCrossCheck: no matching scripted test → no entry (nothing to diff against)', () => {
  const agent: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed' }];
  const scripted: BehaviorResult[] = [];
  assert.deepEqual(diffCrossCheck(agent, scripted), []);
});

test('diffCrossCheck: scripted entry is untested/skipped → no entry (no test outcome to diff)', () => {
  const agent: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed' }];
  const scripted: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'skipped', method: SCRIPTED_METHOD, rationale: 'untested: no generated test matched this behavior id' }];
  assert.deepEqual(diffCrossCheck(agent, scripted), []);
});

// ---------------------------------------------------------------------------
// scriptedModeExitCode — --mode scripted exit code mapping
// ---------------------------------------------------------------------------

test('scriptedModeExitCode: matched === 0 → ALL_UNTESTED regardless of results', () => {
  assert.equal(scriptedModeExitCode(0, []), ExitCode.ALL_UNTESTED);
});

test('scriptedModeExitCode: matched > 0, no failures → SUCCESS', () => {
  const results: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed', method: SCRIPTED_METHOD }];
  assert.equal(scriptedModeExitCode(1, results), ExitCode.SUCCESS);
});

test('scriptedModeExitCode: matched > 0, at least one failure → ASSERTION_FAILURE', () => {
  const results: BehaviorResult[] = [
    { id: 'a/1', description: 'x', status: 'passed', method: SCRIPTED_METHOD },
    { id: 'a/2', description: 'y', status: 'failed', method: SCRIPTED_METHOD },
  ];
  assert.equal(scriptedModeExitCode(1, results), ExitCode.ASSERTION_FAILURE);
});

test('scriptedModeExitCode: matched > 0 with only untested (skipped) behaviors and no failures → SUCCESS', () => {
  const results: BehaviorResult[] = [
    { id: 'a/1', description: 'x', status: 'passed', method: SCRIPTED_METHOD },
    { id: 'a/2', description: 'y', status: 'skipped', method: SCRIPTED_METHOD, rationale: 'untested: no generated test matched this behavior id' },
  ];
  assert.equal(scriptedModeExitCode(1, results), ExitCode.SUCCESS);
});
