import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { startDaemonServer, resolveToken } from './server.js';
import { inbox, __setRunnerForTesting } from './inbox.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';

const fakeRunner = async (_opts: SdkRunnerOptions): Promise<SdkRunnerResult> => ({
  result: 'ok',
  costUsd: 0,
  structuredOutput: { pass: true },
});

function pickPort(): number {
  return 5000 + Math.floor(Math.random() * 4000);
}

function request(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json: unknown; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json, text: buf });
      });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function waitForHealth(port: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(port, '/health');
      if (res.status === 200) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('daemon never came up');
}

test('daemon HTTP: /health no auth, /inbox requires bearer', async (t) => {
  inbox.reset();
  const prev = __setRunnerForTesting(fakeRunner);
  const port = pickPort();
  const original = process.env.SPECIFY_INBOX_TOKEN;
  process.env.SPECIFY_INBOX_TOKEN = 'test-token-123';
  // Start daemon in background; it resolves only when SIGINT fires, so we
  // fork it as a promise and close via SIGTERM at the end.
  const serverPromise = startDaemonServer({ port, host: '127.0.0.1', maxWorkers: 0 });
  t.after(async () => {
    process.kill(process.pid, 'SIGTERM');
    try { await serverPromise; } catch { /* ignore */ }
    if (original === undefined) delete process.env.SPECIFY_INBOX_TOKEN;
    else process.env.SPECIFY_INBOX_TOKEN = original;
    __setRunnerForTesting(prev);
    inbox.reset();
  });

  await waitForHealth(port);

  const health = await request(port, '/health');
  assert.equal(health.status, 200);
  assert.equal((health.json as { ok: boolean }).ok, true);

  const unauth = await request(port, '/inbox', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(unauth.status, 401);

  const token = resolveToken();
  assert.equal(token, 'test-token-123');

  const noTask = await request(port, '/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assert.equal(noTask.status, 400);
  assert.equal((noTask.json as { field: string }).field, 'task');

  const invalidTask = await request(port, '/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ task: 'hack', prompt: 'hi' }),
  });
  assert.equal(invalidTask.status, 400);

  const accepted = await request(port, '/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ task: 'freeform', prompt: 'hello' }),
  });
  assert.equal(accepted.status, 202);
  const msgId = (accepted.json as { id: string }).id;
  assert.ok(msgId.startsWith('msg_'));

  // Wait for dispatch
  await new Promise((r) => setTimeout(r, 50));

  const detail = await request(port, `/inbox/${msgId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(detail.status, 200);
  assert.equal((detail.json as { status: string }).status, 'completed');

  // /verify missing spec
  const verifyNoSpec = await request(port, '/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: 'http://x' }),
  });
  assert.equal(verifyNoSpec.status, 400);
});
