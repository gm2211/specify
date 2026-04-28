import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HonchoMemoryProvider,
  honchoConfigFromEnv,
  honchoEnabled,
  honchoFromEnv,
} from './honcho-provider.js';
import type { MemoryScope } from './memory-provider.js';

function tmpSpec(): { specPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-honcho-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { specPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('honchoEnabled / honchoConfigFromEnv: gates on HONCHO_URL', () => {
  assert.equal(honchoEnabled({}), false);
  assert.equal(honchoEnabled({ HONCHO_URL: 'http://x' }), true);
  const cfg = honchoConfigFromEnv({ HONCHO_URL: 'http://x', HONCHO_APP: 'a', HONCHO_USER: 'u' });
  assert.deepEqual(cfg, { url: 'http://x', app: 'a', user: 'u', token: undefined });
});

test('honchoFromEnv: returns null when not configured', () => {
  assert.equal(honchoFromEnv({}), null);
});

test('HonchoMemoryProvider.prefetch: appends dialectic representation when fetch succeeds', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/dialectic')) {
        return new Response(JSON.stringify({ representation: 'User cares about empty states.' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const provider = new HonchoMemoryProvider({
      url: 'http://localhost:9999',
      app: 'specify',
      user: 'gmecocci',
      fetchImpl,
    });
    const scope: MemoryScope = { specPath, specId: 'demo', target: { type: 'web', url: 'https://x.test' } };
    const prompt = await provider.prefetch(scope);
    assert.match(prompt, /Dialectic user model/);
    assert.match(prompt, /empty states/);
    assert.ok(calls.some((c) => c.includes('/dialectic')));
  } finally {
    cleanup();
  }
});

test('HonchoMemoryProvider.prefetch: silently falls back when Honcho returns non-OK', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const provider = new HonchoMemoryProvider({ url: 'http://x', fetchImpl });
    const scope: MemoryScope = { specPath, specId: 'demo', target: { type: 'web', url: 'https://x.test' } };
    const out = await provider.prefetch(scope);
    assert.equal(out, '', 'with no local rows and Honcho 500, prefetch returns empty');
  } finally {
    cleanup();
  }
});

test('HonchoMemoryProvider.write: writes locally + posts events; survives Honcho 500', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    let posted = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/events')) {
        posted += 1;
        return new Response('error', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const provider = new HonchoMemoryProvider({ url: 'http://x', fetchImpl });
    const scope: MemoryScope = { specPath, specId: 'demo', target: { type: 'web', url: 'https://x.test' } };
    const result = await provider.write(scope, 'run_1', [
      { type: 'observation', content: 'noted something' },
    ]);
    assert.equal(result.rows.length, 1);
    assert.equal(posted, 1, 'event POST was attempted');
  } finally {
    cleanup();
  }
});
