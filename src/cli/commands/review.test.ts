import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';

import { resolveReviewHost } from './review.js';

// The review webapp's HTTP API is unauthenticated, so the bind-address
// resolution is security-relevant (SP-q50): it must default to loopback
// and only widen on an explicit opt-in.

let originalEnv: string | undefined;
beforeEach(() => {
  originalEnv = process.env.SPECIFY_REVIEW_HOST;
  delete process.env.SPECIFY_REVIEW_HOST;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.SPECIFY_REVIEW_HOST;
  else process.env.SPECIFY_REVIEW_HOST = originalEnv;
});

test('resolveReviewHost defaults to loopback-only (127.0.0.1) with no flag and no env var', () => {
  assert.equal(resolveReviewHost(undefined), '127.0.0.1');
});

test('resolveReviewHost honors an explicit --host flag', () => {
  assert.equal(resolveReviewHost('0.0.0.0'), '0.0.0.0');
});

test('resolveReviewHost falls back to SPECIFY_REVIEW_HOST when no flag is given', () => {
  process.env.SPECIFY_REVIEW_HOST = '0.0.0.0';
  assert.equal(resolveReviewHost(undefined), '0.0.0.0');
});

test('resolveReviewHost prefers the --host flag over SPECIFY_REVIEW_HOST', () => {
  process.env.SPECIFY_REVIEW_HOST = '0.0.0.0';
  assert.equal(resolveReviewHost('192.168.1.5'), '192.168.1.5');
});

test('resolveReviewHost treats a blank --host flag as unset (falls through to env/default)', () => {
  assert.equal(resolveReviewHost('   '), '127.0.0.1');
  process.env.SPECIFY_REVIEW_HOST = '0.0.0.0';
  assert.equal(resolveReviewHost(''), '0.0.0.0');
});
