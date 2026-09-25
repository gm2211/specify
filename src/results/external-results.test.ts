import assert from 'node:assert/strict';
import test from 'node:test';

import type { Spec } from '../spec/types.js';
import { validateExternalResults } from './external-results.js';

const spec: Spec = {
  version: '2',
  name: 'Example',
  target: { type: 'cli', binary: 'example' },
  areas: [
    {
      id: 'account',
      name: 'Account',
      behaviors: [
        { id: 'logs-in', description: 'A member can log in.' },
        { id: 'logs-out', description: 'A member can log out.' },
      ],
    },
  ],
};

test('external results derive identity, summary and pass instead of trusting supplied claims', () => {
  const checked = validateExternalResults(spec, {
    structuredOutput: {
      spec: { name: 'Wrong app', version: '1' },
      pass: true,
      summary: { total: 100, passed: 100, failed: 0, skipped: 0 },
      results: [
        { id: 'account/logs-in', status: 'passed', evidence: [] },
        {
          id: 'account/logs-out',
          status: 'failed',
          rationale: 'Logged-out session stayed active.',
        },
      ],
    },
  });
  assert.equal(checked.valid, true);
  if (!checked.valid) return;
  assert.equal(checked.complete, true);
  assert.deepEqual(checked.summary, {
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    untested: 0,
  });
  assert.equal(checked.report.pass, false);
  assert.deepEqual(checked.report.spec, { name: 'Example', version: '2' });
  assert.equal(checked.report.results[0].description, 'A member can log in.');
});

test('missing contract IDs are incomplete and cannot pass', () => {
  const checked = validateExternalResults(spec, {
    results: [{ id: 'account/logs-in', status: 'passed' }],
    pass: true,
  });
  assert.equal(checked.valid, true);
  if (!checked.valid) return;
  assert.equal(checked.complete, false);
  assert.deepEqual(checked.missingIds, ['account/logs-out']);
  assert.equal(checked.summary.untested, 1);
  assert.equal(checked.report.pass, false);
});

test('a skipped behavior cannot make the derived report pass', () => {
  const checked = validateExternalResults(spec, {
    results: [
      { id: 'account/logs-in', status: 'passed' },
      { id: 'account/logs-out', status: 'skipped' },
    ],
  });
  assert.equal(checked.valid, true);
  if (!checked.valid) return;
  assert.equal(checked.complete, true);
  assert.equal(checked.report.pass, false);
  assert.equal(checked.summary.skipped, 1);
});

test('malformed, unknown, duplicate and invalid-status rows are rejected', () => {
  const checked = validateExternalResults(spec, {
    results: [
      null,
      { id: 'unknown/behavior', status: 'passed' },
      { id: 'account/logs-in', status: 'passed' },
      { id: 'account/logs-in', status: 'failed' },
      { id: 'account/logs-out', status: 'green' },
    ],
  });
  assert.equal(checked.valid, false);
  if (checked.valid) return;
  assert.deepEqual(
    checked.errors.map((error) => error.path),
    ['/results/0', '/results/1/id', '/results/3/id', '/results/4/status'],
  );
});

test('malformed nested evidence and forged runner verdicts are rejected', () => {
  const checked = validateExternalResults(spec, {
    results: [
      {
        id: 'account/logs-in',
        status: 'passed',
        evidence: [{ type: 'command_output', label: 'output', content: 42 }],
        action_trace: [{ type: 'click', description: 'Clicked', screenshot: 1 }],
        repro: { confirmed: true, output: 'pass' },
      },
    ],
  });
  assert.equal(checked.valid, false);
  if (checked.valid) return;
  assert.deepEqual(
    checked.errors.map((error) => error.path),
    ['/results/0/evidence/0/content', '/results/0/action_trace/0/screenshot', '/results/0/repro'],
  );
});

test('stale descriptions are replaced by contract prose while malformed timestamps are rejected', () => {
  const checked = validateExternalResults(spec, {
    timestamp: 123,
    results: [{ id: 'account/logs-in', status: 'passed', description: 'An older claim.' }],
  });
  assert.equal(checked.valid, false);
  if (checked.valid) return;
  assert.deepEqual(
    checked.errors.map((error) => error.path),
    ['/timestamp'],
  );
  const accepted = validateExternalResults(spec, {
    results: [{ id: 'account/logs-in', status: 'passed', description: 'An older claim.' }],
  });
  assert.equal(accepted.valid, true);
  if (accepted.valid) {
    assert.equal(accepted.report.results[0].description, 'A member can log in.');
  }
});

test('a complete all-passed result yields a passing normalized report', () => {
  const checked = validateExternalResults(spec, {
    results: [
      { id: 'account/logs-in', status: 'passed' },
      { id: 'account/logs-out', status: 'passed' },
    ],
  });
  assert.equal(checked.valid, true);
  if (!checked.valid) return;
  assert.equal(checked.report.pass, true);
  assert.equal(checked.summary.passed, 2);
});

test('empty contracts cannot pass vacuously', () => {
  const checked = validateExternalResults({ ...spec, areas: [] }, { results: [] });
  assert.equal(checked.valid, false);
  if (!checked.valid) {
    assert.match(checked.errors[0].message, /at least one behavior/);
  }
});

test('duplicate contract identities cannot silently collapse in result lookup', () => {
  const duplicateArea: Spec = { ...spec, areas: [spec.areas[0], spec.areas[0]] };
  const checked = validateExternalResults(duplicateArea, {
    results: [
      { id: 'account/logs-in', status: 'passed' },
      { id: 'account/logs-out', status: 'passed' },
    ],
  });
  assert.equal(checked.valid, false);
  if (!checked.valid) {
    assert.ok(checked.errors.some((error) => /duplicate contract area ID/.test(error.message)));
    assert.ok(checked.errors.some((error) => /duplicate contract behavior ID/.test(error.message)));
  }
});
