import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDecisionsMcpServer, type DecisionsMcpContext } from './decisions-mcp.js';
import { resolveDecision } from './pending-decisions.js';
import { eventBus } from './event-bus.js';
import { _internals as budgetInternals } from './tool-budget.js';

let origHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-dec-mcp-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  budgetInternals.counters.clear();
  delete process.env.SPECIFY_TOOL_BUDGET_FILE_DECISION;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

type AnyServer = {
  instance?: {
    _registeredTools?: Record<
      string,
      {
        handler: (
          args: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
      }
    >;
  };
};

function findHandler(
  server: ReturnType<typeof createDecisionsMcpServer>,
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
  const anyServer = server as unknown as AnyServer;
  const tools = anyServer.instance?._registeredTools ?? {};
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not found (have: ${Object.keys(tools).join(', ')})`);
  return t.handler;
}

const fakeScope = { specPath: '/fake', specId: 'testspec', target: { type: 'web' as const } };

function makeCtx(overrides: Partial<DecisionsMcpContext> = {}): DecisionsMcpContext {
  return {
    specId: 'testspec',
    runId: 'run_test',
    memoryScope: fakeScope,
    ...overrides,
  };
}

const baseArgs = {
  question: 'Is the 500 a real bug?',
  context: 'Page at /dashboard returns HTTP 500 on first load.',
  proposed_resolutions: [
    { scope: 'narrow', label: 'Skip for now' },
    {
      scope: 'medium',
      label: 'Expected — backend not seeded',
      action_hint: 'Skip the dashboard check',
    },
  ],
  blocking: false,
};

test('file_decision non-blocking: returns id + status=open immediately', async () => {
  const server = createDecisionsMcpServer(makeCtx());
  const handler = findHandler(server, 'file_decision');
  const res = await handler(baseArgs);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, true);
  assert.match(body.id, /^dec_[0-9a-f]{8}$/);
  assert.equal(body.status, 'open');
});

test('file_decision non-blocking: emits feedback:decision_filed event', async () => {
  const server = createDecisionsMcpServer(makeCtx());
  const handler = findHandler(server, 'file_decision');
  let captured: Record<string, unknown> = {};
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:decision_filed') captured = ev.data;
  });
  try {
    await handler(baseArgs);
    assert.equal(captured.specId, 'testspec');
    assert.ok(Array.isArray(captured.scopes));
  } finally {
    off();
  }
});

test('file_decision blocking: resolves with correct payload when human resolves', async () => {
  const server = createDecisionsMcpServer(makeCtx());
  const handler = findHandler(server, 'file_decision');

  let capturedId = '';
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:decision_filed') capturedId = ev.data.id as string;
  });

  const handlerPromise = handler({ ...baseArgs, blocking: true, timeout_seconds: 10 });

  // wait until the decision is filed
  await new Promise((r) => setTimeout(r, 20));
  off();

  assert.ok(capturedId, 'should have captured a decision id');
  await resolveDecision(capturedId, { resolution_index: 1, scope: 'medium' });

  const res = await handlerPromise;
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.id, capturedId);
  assert.equal(body.resolution.scope, 'medium');
  assert.equal(body.resolution.resolution_index, 1);
  assert.equal(body.resolution.label, 'Expected — backend not seeded');
  assert.equal(body.resolution.action_hint, 'Skip the dashboard check');
});

test('file_decision blocking: times out and returns ok=false', async () => {
  const server = createDecisionsMcpServer(makeCtx());
  const handler = findHandler(server, 'file_decision');
  const res = await handler({ ...baseArgs, blocking: true, timeout_seconds: 0.05 });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'timeout');
});

test('file_decision medium-scope resolution: writes memory row via provider', async () => {
  const written: Array<{ deltas: unknown }> = [];
  const fakeProvider = {
    read: async () => ({ rows: [] }),
    write: async (_scope: unknown, _runId: string, deltas: unknown) => {
      written.push({ deltas });
      return { rows: [] };
    },
    prefetch: async () => '',
  };

  const server = createDecisionsMcpServer(makeCtx({ memoryProvider: fakeProvider as never }));
  const handler = findHandler(server, 'file_decision');

  let capturedId = '';
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:decision_filed') capturedId = ev.data.id as string;
  });
  const handlerPromise = handler({ ...baseArgs, blocking: true, timeout_seconds: 10 });
  await new Promise((r) => setTimeout(r, 20));
  off();

  await resolveDecision(
    capturedId,
    { resolution_index: 1, scope: 'medium' },
    async (_scope, _runId, deltas) => {
      written.push({ deltas });
    },
    fakeScope as never,
  );
  await handlerPromise;

  assert.ok(written.length > 0);
  const delta = (written[0].deltas as Array<{ type: string; content: string }>)[0];
  assert.equal(delta.type, 'observation');
  assert.match(delta.content, /Human ruling on/);
});

test('file_decision broad-scope resolution: writes playbook memory row', async () => {
  const written: Array<{ deltas: unknown }> = [];
  const server = createDecisionsMcpServer(makeCtx());
  const handler = findHandler(server, 'file_decision');

  let capturedId = '';
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:decision_filed') capturedId = ev.data.id as string;
  });
  const args = {
    ...baseArgs,
    proposed_resolutions: [
      { scope: 'narrow', label: 'Ignore' },
      { scope: 'broad', label: 'Always skip this check across all specs' },
    ],
    blocking: true,
    timeout_seconds: 10,
  };
  const handlerPromise = handler(args);
  await new Promise((r) => setTimeout(r, 20));
  off();

  await resolveDecision(
    capturedId,
    { resolution_index: 1, scope: 'broad' },
    async (_scope, _runId, deltas) => {
      written.push({ deltas });
    },
    fakeScope as never,
  );
  await handlerPromise;

  assert.ok(written.length > 0);
  const delta = (written[0].deltas as Array<{ type: string }>)[0];
  assert.equal(delta.type, 'playbook');
});

test('file_decision budget exceeded returns structured error and does not append decision', async () => {
  process.env.SPECIFY_TOOL_BUDGET_FILE_DECISION = '2';
  const server = createDecisionsMcpServer(makeCtx({ runId: 'run_budget_dec' }));
  const handler = findHandler(server, 'file_decision');

  const decisionIds: string[] = [];
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:decision_filed') decisionIds.push(ev.data.id as string);
  });

  await handler(baseArgs);
  await handler(baseArgs);
  assert.equal(decisionIds.length, 2);

  const res = await handler(baseArgs);
  off();

  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'budget_exceeded');
  assert.equal(body.tool, 'file_decision');
  assert.equal(body.limit, 2);
  assert.equal(body.used, 2);
  assert.equal(decisionIds.length, 2, 'should not have appended a third decision');
});
