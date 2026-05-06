import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _internals,
  createFeedbackMcpServer,
  feedbackSinkFromEnv,
  type FeedbackMcpContext,
} from './feedback-mcp.js';
import { eventBus } from './event-bus.js';

test('feedbackSinkFromEnv: defaults to bd when nothing set', () => {
  assert.deepEqual(feedbackSinkFromEnv({}), { kind: 'bd' });
});

test('feedbackSinkFromEnv: http when SPECIFY_FEEDBACK_URL is set', () => {
  assert.deepEqual(
    feedbackSinkFromEnv({
      SPECIFY_FEEDBACK_URL: 'https://feedback.example/tickets',
      SPECIFY_FEEDBACK_BEARER_FILE: '/run/secrets/fb',
    }),
    { kind: 'http', url: 'https://feedback.example/tickets', bearerFile: '/run/secrets/fb' },
  );
});

test('severityToPriority: maps the four levels to bd priorities', () => {
  assert.equal(_internals.severityToPriority('critical'), '0');
  assert.equal(_internals.severityToPriority('major'),    '1');
  assert.equal(_internals.severityToPriority('minor'),    '2');
  assert.equal(_internals.severityToPriority('cosmetic'), '3');
});

test('parseBdId: extracts SP-xyz from bd create output', () => {
  assert.equal(_internals.parseBdId('✓ Created issue: SP-abc1 — A bug\n'), 'SP-abc1');
  assert.throws(() => _internals.parseBdId('no id here'), /did not contain/);
});

test('composeDescription: appends spec + run + area + behavior', () => {
  const text = _internals.composeDescription(
    { specId: 'Renzo', runId: 'run_1', sink: { kind: 'bd' } } as FeedbackMcpContext,
    { summary: 's', description: 'd', severity: 'minor', area_id: 'home', behavior_id: 'loads' },
  );
  assert.match(text, /spec Renzo/);
  assert.match(text, /run run_1/);
  assert.match(text, /Area: home/);
  assert.match(text, /Behavior: loads/);
});

// The createSdkMcpServer object exposes the tool list under `tools` once
// the SDK constructs it; the test interacts with the registered tool by
// finding it on the returned server and invoking the handler manually.
function findHandler(server: ReturnType<typeof createFeedbackMcpServer>, name: string): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
  // The agent SDK stores registered tools under instance._registeredTools.
  // Internal layout — fine for tests; if it shifts, this surfaces it.
  const anyServer = server as unknown as { instance?: { _registeredTools?: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }> } };
  const tools = anyServer.instance?._registeredTools ?? {};
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not found on server (have: ${Object.keys(tools).join(', ')})`);
  return t.handler;
}

test('file_ticket via bd: shells with right args, parses id, emits event', async () => {
  const calls: string[][] = [];
  const ctx: FeedbackMcpContext = {
    specId: 'Renzo',
    runId: 'run_test',
    sink: { kind: 'bd' },
    bdExec: async (args) => {
      calls.push(args);
      return { stdout: '✓ Created issue: SP-zz1 — Login broken\n', code: 0 };
    },
  };
  const server = createFeedbackMcpServer(ctx);
  let captured: { type?: string; data?: Record<string, unknown> } = {};
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:ticket_filed') captured = { type: ev.type, data: ev.data };
  });
  try {
    const handler = findHandler(server, 'file_ticket');
    const res = await handler({
      summary: 'Login button is dead',
      description: 'Clicking the login button does nothing on Safari 17.',
      severity: 'major',
      area_id: 'auth',
      behavior_id: 'login-form-visible',
    });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.id, 'SP-zz1');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['create', '--title']);
    assert.ok(calls[0].includes('Login button is dead'));
    assert.ok(calls[0].includes('--priority'));
    assert.ok(calls[0].includes('1'));
    assert.equal(captured.type, 'feedback:ticket_filed');
    assert.equal((captured.data as { id: string }).id, 'SP-zz1');
  } finally {
    off();
  }
});

test('file_ticket via http: posts JSON, returns echoed id', async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: 'TKT-42' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const ctx: FeedbackMcpContext = {
    specId: 'Renzo',
    runId: 'run_http',
    sink: { kind: 'http', url: 'https://feedback.example/tickets' },
    fetchImpl,
  };
  const server = createFeedbackMcpServer(ctx);
  const handler = findHandler(server, 'file_ticket');
  const res = await handler({
    summary: 'Header overlaps content',
    description: 'On mobile breakpoints, the sticky header occludes the first paragraph.',
    severity: 'minor',
  });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.id, 'TKT-42');
  assert.equal(captured.url, 'https://feedback.example/tickets');
  const sent = JSON.parse(captured.init?.body as string);
  assert.equal(sent.specId, 'Renzo');
  assert.equal(sent.severity, 'minor');
});

test('file_ticket via http: bearer file is mounted as Authorization', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-fb-'));
  try {
    const bearerFile = path.join(dir, 'bearer');
    fs.writeFileSync(bearerFile, 'fb-secret\n');
    let auth = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ id: 'X' }), { status: 200 });
    }) as typeof fetch;
    const server = createFeedbackMcpServer({
      specId: 's',
      runId: 'r',
      sink: { kind: 'http', url: 'https://x', bearerFile },
      fetchImpl,
    });
    const handler = findHandler(server, 'file_ticket');
    await handler({ summary: 'x', description: 'y', severity: 'minor' });
    assert.equal(auth, 'Bearer fb-secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file_ticket via http: non-OK response surfaces a clean error', async () => {
  const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
  const server = createFeedbackMcpServer({
    specId: 's',
    runId: 'r',
    sink: { kind: 'http', url: 'https://x' },
    fetchImpl,
  });
  const handler = findHandler(server, 'file_ticket');
  await assert.rejects(
    handler({ summary: 'x', description: 'y', severity: 'critical' }),
    /Feedback HTTP sink 429/,
  );
});
