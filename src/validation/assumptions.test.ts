import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAssumptions } from './assumptions.js';

test('validateAssumptions resolves spec variables in assumption URLs', async (t) => {
  const originalFetch = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestedUrl = '';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    assert.equal(init?.method, 'HEAD');
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const results = await validateAssumptions(
    [{ type: 'url_reachable', url: '{{base_url}}', description: 'App is running' }],
    { variables: { base_url: 'https://app.example.test' } },
  );

  assert.equal(requestedUrl, 'https://app.example.test');
  assert.equal(results[0]?.status, 'passed');
});

test('validateAssumptions resolves env-backed spec variables in assumption URLs', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.TARGET_BASE_URL;

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) {
      delete process.env.TARGET_BASE_URL;
    } else {
      process.env.TARGET_BASE_URL = originalBaseUrl;
    }
  });

  process.env.TARGET_BASE_URL = 'https://env.example.test';

  let requestedUrl = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const results = await validateAssumptions(
    [{ type: 'url_reachable', url: '{{base_url}}', description: 'App is running' }],
    { variables: { base_url: '${TARGET_BASE_URL}' } },
  );

  assert.equal(requestedUrl, 'https://env.example.test');
  assert.equal(results[0]?.status, 'passed');
});
