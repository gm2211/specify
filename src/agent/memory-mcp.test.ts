import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { createMemoryMcpServer, type MemoryMcpContext } from './memory-mcp.js';
import { _internals as budgetInternals } from './tool-budget.js';

beforeEach(() => {
  budgetInternals.counters.clear();
  delete process.env.SPECIFY_TOOL_BUDGET_MEMORY_RECORD;
  delete process.env.SPECIFY_TOOL_BUDGET_MEMORY_LIST;
});

type AnyServer = {
  instance?: {
    _registeredTools?: Record<string, {
      handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }>;
  };
};

function findHandler(
  server: ReturnType<typeof createMemoryMcpServer>,
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
  const anyServer = server as unknown as AnyServer;
  const tools = anyServer.instance?._registeredTools ?? {};
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not found (have: ${Object.keys(tools).join(', ')})`);
  return t.handler;
}

const fakeScope = { specPath: '/fake', specId: 'testspec', target: { type: 'web' as const } };

function makeCtx(runId = 'run_test'): MemoryMcpContext {
  const rows: Array<{ type: string; content: string }> = [];
  const base = { version: 1 as const, spec_id: 'testspec', target_key: 'web:fake' };
  return {
    scope: fakeScope,
    runId,
    provider: {
      read: async () => ({ ...base, rows: rows as never }),
      write: async (_scope, _runId, deltas) => {
        for (const d of deltas as Array<{ type: string; content: string }>) rows.push(d);
        return { ...base, rows: rows as never };
      },
      prefetch: async () => '',
    },
  };
}

test('memory_record budget exceeded returns structured error', async () => {
  process.env.SPECIFY_TOOL_BUDGET_MEMORY_RECORD = '2';
  const ctx = makeCtx('run_budget_record');
  const server = createMemoryMcpServer(ctx);
  const handler = findHandler(server, 'memory_record');

  const args = { type: 'observation', content: 'test fact' };
  await handler(args);
  await handler(args);
  const res = await handler(args);

  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'budget_exceeded');
  assert.equal(body.tool, 'memory_record');
  assert.equal(body.limit, 2);
  assert.equal(body.used, 2);
  assert.ok(body.hint);
});

test('memory_list budget exceeded returns structured error', async () => {
  process.env.SPECIFY_TOOL_BUDGET_MEMORY_LIST = '2';
  const ctx = makeCtx('run_budget_list');
  const server = createMemoryMcpServer(ctx);
  const handler = findHandler(server, 'memory_list');

  await handler({});
  await handler({});
  const res = await handler({});

  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'budget_exceeded');
  assert.equal(body.tool, 'memory_list');
  assert.equal(body.limit, 2);
  assert.equal(body.used, 2);
  assert.ok(body.hint);
});
