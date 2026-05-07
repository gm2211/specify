import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startDaemonServer, resolveToken } from './server.js';
import { inbox, __setRunnerForTesting } from './inbox.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';
import { appendDecision } from '../agent/pending-decisions.js';

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

test('daemon HTTP: /decisions endpoints require bearer and behave correctly', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-dec-srv-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  inbox.reset();
  const prev = __setRunnerForTesting(fakeRunner);
  const port = pickPort();
  const original = process.env.SPECIFY_INBOX_TOKEN;
  process.env.SPECIFY_INBOX_TOKEN = 'dec-token-456';
  const serverPromise = startDaemonServer({ port, host: '127.0.0.1', maxWorkers: 0 });
  t.after(async () => {
    process.kill(process.pid, 'SIGTERM');
    try { await serverPromise; } catch { /* ignore */ }
    if (original === undefined) delete process.env.SPECIFY_INBOX_TOKEN;
    else process.env.SPECIFY_INBOX_TOKEN = original;
    __setRunnerForTesting(prev);
    inbox.reset();
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  await waitForHealth(port);
  const token = 'dec-token-456';
  const auth = { authorization: `Bearer ${token}` };

  // Seed a decision directly via the store
  const d = appendDecision({
    specId: 'testspec',
    runId: 'run_001',
    question: 'Bug or feature?',
    context: 'Page shows 404',
    proposed_resolutions: [
      { scope: 'narrow', label: 'Skip' },
      { scope: 'medium', label: 'Known issue' },
    ],
  });

  // GET /decisions returns list
  const listRes = await request(port, `/decisions?specId=testspec&status=open`, { headers: auth });
  assert.equal(listRes.status, 200);
  const listBody = listRes.json as { decisions: Array<{ id: string }> };
  assert.ok(Array.isArray(listBody.decisions));
  assert.ok(listBody.decisions.some((x) => x.id === d.id));

  // GET /decisions/:id returns the decision
  const getRes = await request(port, `/decisions/${d.id}`, { headers: auth });
  assert.equal(getRes.status, 200);
  assert.equal((getRes.json as { id: string }).id, d.id);

  // GET /decisions/:id with unknown id → 404
  const missingRes = await request(port, `/decisions/dec_deadbeef`, { headers: auth });
  assert.equal(missingRes.status, 404);

  // POST /decisions/:id/resolve with scope mismatch → 400
  const mismatchRes = await request(port, `/decisions/${d.id}/resolve`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ resolution_index: 0, scope: 'broad' }),
  });
  assert.equal(mismatchRes.status, 400);
  assert.equal((mismatchRes.json as { error: string }).error, 'scope_mismatch');

  // POST /decisions/:id/resolve with valid body → resolves
  const resolveRes = await request(port, `/decisions/${d.id}/resolve`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ resolution_index: 0, scope: 'narrow', resolved_by: 'tester' }),
  });
  assert.equal(resolveRes.status, 200);
  assert.equal((resolveRes.json as { status: string }).status, 'resolved');

  // POST /decisions/:id/resolve again → 409
  const doubleRes = await request(port, `/decisions/${d.id}/resolve`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ resolution_index: 0, scope: 'narrow' }),
  });
  assert.equal(doubleRes.status, 409);
});
