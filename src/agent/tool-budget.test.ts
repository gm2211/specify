import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  getBudget,
  enforceBudget,
  resetRunBudget,
  getRunUsage,
  _internals,
} from './tool-budget.js';
import { eventBus } from './event-bus.js';

beforeEach(() => {
  _internals.counters.clear();
});

test('getBudget returns default for known tool', () => {
  assert.equal(getBudget('memory_record', {}), 50);
  assert.equal(getBudget('memory_list', {}), 100);
  assert.equal(getBudget('file_ticket', {}), 10);
  assert.equal(getBudget('file_decision', {}), 5);
});

test('getBudget honors env override', () => {
  assert.equal(getBudget('file_ticket', { SPECIFY_TOOL_BUDGET_FILE_TICKET: '3' }), 3);
  assert.equal(getBudget('memory_record', { SPECIFY_TOOL_BUDGET_MEMORY_RECORD: '200' }), 200);
});

test('getBudget returns Infinity for unknown tool', () => {
  assert.equal(getBudget('nonexistent_tool', {}), Infinity);
});

test('enforceBudget allows up to limit', () => {
  const env = { SPECIFY_TOOL_BUDGET_FILE_TICKET: '3' };
  const r1 = enforceBudget('run1', 'file_ticket', env);
  const r2 = enforceBudget('run1', 'file_ticket', env);
  const r3 = enforceBudget('run1', 'file_ticket', env);
  assert.ok(r1.ok);
  assert.ok(r2.ok);
  assert.ok(r3.ok);
  assert.deepEqual(getRunUsage('run1'), { file_ticket: 3 });
});

test('enforceBudget rejects beyond limit and emits event', () => {
  const env = { SPECIFY_TOOL_BUDGET_FILE_TICKET: '2' };
  enforceBudget('run2', 'file_ticket', env);
  enforceBudget('run2', 'file_ticket', env);

  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'tool:budget_exceeded') events.push({ type: ev.type, data: ev.data });
  });

  const result = enforceBudget('run2', 'file_ticket', env);
  off();

  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.limit, 2);
    assert.equal(result.used, 2);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].data.toolName, 'file_ticket');
  assert.equal(events[0].data.runId, 'run2');

  const usageAfter = getRunUsage('run2');
  assert.equal(usageAfter.file_ticket, 2);
});

test('resetRunBudget clears counters for that run', () => {
  const env = { SPECIFY_TOOL_BUDGET_FILE_TICKET: '10' };
  enforceBudget('run3', 'file_ticket', env);
  enforceBudget('run3', 'file_ticket', env);
  assert.equal(getRunUsage('run3').file_ticket, 2);

  resetRunBudget('run3');
  assert.deepEqual(getRunUsage('run3'), {});
});

test('inbox:completed event triggers resetRunBudget', () => {
  const env = { SPECIFY_TOOL_BUDGET_FILE_TICKET: '10' };
  enforceBudget('run4', 'file_ticket', env);
  assert.equal(getRunUsage('run4').file_ticket, 1);

  eventBus.send('inbox:completed', { id: 'run4', costUsd: 0.01 });

  assert.deepEqual(getRunUsage('run4'), {});
});

test('inbox:failed event triggers resetRunBudget', () => {
  const env = { SPECIFY_TOOL_BUDGET_FILE_TICKET: '10' };
  enforceBudget('run5', 'file_ticket', env);
  assert.equal(getRunUsage('run5').file_ticket, 1);

  eventBus.send('inbox:failed', { id: 'run5', error: 'boom' });

  assert.deepEqual(getRunUsage('run5'), {});
});
