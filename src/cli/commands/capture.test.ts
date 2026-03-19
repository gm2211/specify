import assert from 'node:assert/strict';
import test from 'node:test';
import { navigateWithLoadFallback } from './capture.js';

test('navigateWithLoadFallback waits for load without triggering a second goto', async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const timeoutError = new Error('Timed out');
  timeoutError.name = 'TimeoutError';

  const page = {
    async goto() {
      calls.push('goto');
      throw timeoutError;
    },
    async waitForLoadState() {
      calls.push('waitForLoadState');
    },
  };

  await navigateWithLoadFallback(page, 'https://app.example.test', 5_000, (msg) => {
    logs.push(msg);
  });

  assert.deepEqual(calls, ['goto', 'waitForLoadState']);
  assert.deepEqual(logs, ['networkidle timed out, waiting for load on current page...']);
});

test('navigateWithLoadFallback rethrows non-timeout errors', async () => {
  const navigationError = new Error('Navigation failed');

  const page = {
    async goto() {
      throw navigationError;
    },
    async waitForLoadState() {
      assert.fail('waitForLoadState should not run after non-timeout failures');
    },
  };

  await assert.rejects(
    () => navigateWithLoadFallback(page, 'https://app.example.test', 5_000, () => {}),
    navigationError,
  );
});
