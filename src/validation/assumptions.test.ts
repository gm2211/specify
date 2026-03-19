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
