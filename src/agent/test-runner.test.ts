import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  confirmBehavior,
  decideConfirmation,
  escapeRegExp,
  extractBehaviorId,
  flattenReporterSpecs,
  runPlaywrightTests,
} from './test-runner.js';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-test-runner-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// extractBehaviorId — title mapping contract
// ---------------------------------------------------------------------------

test('extractBehaviorId: parses "<area>/<behavior>: description"', () => {
  assert.equal(
    extractBehaviorId('checkout/apply-coupon: applying a valid coupon reduces the total'),
    'checkout/apply-coupon',
  );
});

test('extractBehaviorId: undefined for free-form titles without the prefix', () => {
  assert.equal(extractBehaviorId('applying a valid coupon reduces the total'), undefined);
});

test('extractBehaviorId: undefined when there is no slash before the colon', () => {
  assert.equal(extractBehaviorId('checkout: applying a valid coupon reduces the total'), undefined);
});

test('escapeRegExp: escapes regex metacharacters', () => {
  assert.equal(escapeRegExp('area.id/behavior-id'), 'area\\.id/behavior-id');
});

// ---------------------------------------------------------------------------
// flattenReporterSpecs — reporter-JSON parsing
// ---------------------------------------------------------------------------

test('flattenReporterSpecs: flattens nested suites and maps behavior ids', () => {
  const report = {
    suites: [
      {
        title: 'checkout.spec.ts',
        suites: [
          {
            title: 'Checkout',
            specs: [
              {
                title: 'checkout/apply-coupon: applying a valid coupon reduces the total',
                ok: true,
                tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
              },
              {
                title: 'checkout/free-shipping: orders over $50 ship free',
                ok: false,
                tests: [
                  {
                    status: 'unexpected',
                    results: [{ status: 'failed', error: { message: 'expect(received).toBe(expected)' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const flat = flattenReporterSpecs(report);
  assert.equal(flat.length, 2);

  const coupon = flat.find((t) => t.title.startsWith('checkout/apply-coupon'));
  assert.ok(coupon);
  assert.equal(coupon!.behaviorId, 'checkout/apply-coupon');
  assert.equal(coupon!.status, 'passed');
  assert.equal(coupon!.error, undefined);

  const shipping = flat.find((t) => t.title.startsWith('checkout/free-shipping'));
  assert.ok(shipping);
  assert.equal(shipping!.behaviorId, 'checkout/free-shipping');
  assert.equal(shipping!.status, 'failed');
  assert.equal(shipping!.error, 'expect(received).toBe(expected)');
});

test('flattenReporterSpecs: empty suites yields empty list', () => {
  assert.deepEqual(flattenReporterSpecs({}), []);
  assert.deepEqual(flattenReporterSpecs({ suites: [] }), []);
});

// ---------------------------------------------------------------------------
// decideConfirmation — confirmed/unconfirmed decision, never overrides status
// ---------------------------------------------------------------------------

test('decideConfirmation: a working generated test (fails on rerun) confirms the failure', () => {
  const tests = [
    {
      title: 'checkout/free-shipping: orders over $50 ship free',
      behaviorId: 'checkout/free-shipping',
      status: 'failed' as const,
      error: 'expect(locator).toBeVisible() failed',
    },
  ];
  const outcome = decideConfirmation(tests, 'checkout/free-shipping');
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.test, 'checkout/free-shipping: orders over $50 ship free');
  assert.match(outcome.output, /generated test failed as expected/);
});

test('decideConfirmation: a broken generated test (passes unexpectedly) does NOT confirm', () => {
  const tests = [
    {
      title: 'checkout/free-shipping: orders over $50 ship free',
      behaviorId: 'checkout/free-shipping',
      status: 'passed' as const,
    },
  ];
  const outcome = decideConfirmation(tests, 'checkout/free-shipping');
  assert.equal(outcome.confirmed, false);
  assert.match(outcome.output, /does not reproduce/);
});

test('decideConfirmation: no matching test is unconfirmed, not an error', () => {
  const outcome = decideConfirmation([], 'checkout/free-shipping');
  assert.equal(outcome.confirmed, false);
  assert.match(outcome.output, /no generated test matched/);
});

// ---------------------------------------------------------------------------
// runPlaywrightTests / confirmBehavior — no-tests-present short circuit
// ---------------------------------------------------------------------------

test('runPlaywrightTests: no spec files present → no_tests, does not spawn anything', async () => {
  const { dir, cleanup } = tmp();
  try {
    const result = await runPlaywrightTests({ cwd: dir });
    assert.deepEqual(result, { ok: false, reason: 'no_tests' });
  } finally {
    cleanup();
  }
});

test('confirmBehavior: no spec files present → undefined (skip quietly)', async () => {
  const { dir, cleanup } = tmp();
  try {
    const outcome = await confirmBehavior('checkout/free-shipping', { cwd: dir });
    assert.equal(outcome, undefined);
  } finally {
    cleanup();
  }
});
