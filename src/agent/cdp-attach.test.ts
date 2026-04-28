import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { defaultCdpEndpoint, attachToUserChrome } from './cdp-attach.js';

test('defaultCdpEndpoint: respects explicit port', () => {
  assert.equal(defaultCdpEndpoint(9333), 'http://localhost:9333');
});

test('defaultCdpEndpoint: reads CHROME_CDP_PORT env', () => {
  const orig = process.env.CHROME_CDP_PORT;
  process.env.CHROME_CDP_PORT = '12345';
  try {
    assert.equal(defaultCdpEndpoint(), 'http://localhost:12345');
  } finally {
    if (orig === undefined) delete process.env.CHROME_CDP_PORT;
    else process.env.CHROME_CDP_PORT = orig;
  }
});

test('defaultCdpEndpoint: falls back to 9222', () => {
  const orig = process.env.CHROME_CDP_PORT;
  delete process.env.CHROME_CDP_PORT;
  try {
    assert.equal(defaultCdpEndpoint(), 'http://localhost:9222');
  } finally {
    if (orig !== undefined) process.env.CHROME_CDP_PORT = orig;
  }
});

test('attachToUserChrome: actionable error when nothing is listening', async () => {
  // No Chrome on this port — connect must fail with a guidance message.
  await assert.rejects(
    () => attachToUserChrome({ port: 1 }),
    (err: Error) => /Failed to connect to Chrome|--remote-debugging-port|CHROME_CDP_PORT/.test(err.message),
  );
});
