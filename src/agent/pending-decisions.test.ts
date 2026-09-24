import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendDecision,
  listDecisions,
  getDecision,
  resolveDecision,
  registerAwaiter,
  _internals,
  type PendingDecision,
} from './pending-decisions.js';
import { eventBus } from './event-bus.js';

let origHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-dec-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const baseDecision = {
  specId: 'myspec',
  runId: 'run_001',
  question: 'Is this a bug?',
  context: 'Page shows 500 error on load',
  proposed_resolutions: [
    { scope: 'narrow' as const, label: 'Skip this behavior for now' },
    {
      scope: 'medium' as const,
      label: 'Known issue — mark as expected',
      action_hint: 'Skip the login check',
    },
    { scope: 'broad' as const, label: 'This is a real bug — file ticket' },
  ],
};

test('appendDecision: generates id, writes to JSONL, returns decision', () => {
  const d = appendDecision(baseDecision);
  assert.match(d.id, /^dec_[0-9a-f]{8}$/);
  assert.equal(d.status, 'open');
  assert.equal(d.specId, 'myspec');
  assert.ok(d.createdAt);

  const filePath = _internals.decisionsPath('myspec');
  assert.ok(fs.existsSync(filePath));
  const lines = _internals.readLines(filePath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, d.id);
});

test('listDecisions: filters by specId and status', () => {
  appendDecision(baseDecision);
  appendDecision({ ...baseDecision, specId: 'otherspec' });

  const forMySpec = listDecisions('myspec');
  assert.equal(forMySpec.length, 1);
  assert.equal(forMySpec[0].specId, 'myspec');

  const all = listDecisions(undefined);
  assert.equal(all.length, 2);

  const open = listDecisions('myspec', { status: 'open' });
  assert.equal(open.length, 1);

  const resolved = listDecisions('myspec', { status: 'resolved' });
  assert.equal(resolved.length, 0);
});

test('getDecision: finds by id across files', () => {
  const d1 = appendDecision(baseDecision);
  const d2 = appendDecision({ ...baseDecision, specId: 'otherspec' });

  assert.deepEqual(getDecision(d1.id)?.id, d1.id);
  assert.deepEqual(getDecision(d2.id)?.id, d2.id);
  assert.equal(getDecision('dec_notexist'), undefined);
});

test('resolveDecision: marks resolved, emits event', async () => {
  const d = appendDecision(baseDecision);
  let evtData: Record<string, unknown> = {};
  const off = eventBus.onAny((ev) => {
    if (ev.type === 'feedback:decision_resolved') evtData = ev.data;
  });
  try {
    const resolved = await resolveDecision(d.id, {
      resolution_index: 0,
      scope: 'narrow',
      resolved_by: 'tester',
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolved?.scope, 'narrow');
    assert.equal(resolved.resolved?.resolution_index, 0);
    assert.equal(resolved.resolved?.resolved_by, 'tester');
    assert.equal(evtData.id, d.id);
    assert.equal(evtData.scope, 'narrow');
  } finally {
    off();
  }
});

test('resolveDecision: rejects on scope mismatch', async () => {
  const d = appendDecision(baseDecision);
  await assert.rejects(
    resolveDecision(d.id, { resolution_index: 0, scope: 'broad' }),
    /Scope mismatch/,
  );
});

test('resolveDecision: rejects if already resolved', async () => {
  const d = appendDecision(baseDecision);
  await resolveDecision(d.id, { resolution_index: 0, scope: 'narrow' });
  await assert.rejects(resolveDecision(d.id, { resolution_index: 0, scope: 'narrow' }), /not open/);
});

test('resolveDecision: calls memoryWriter for medium/broad scope', async () => {
  const d = appendDecision(baseDecision);
  const written: Array<{ deltas: unknown }> = [];
  const fakeWriter = async (_scope: unknown, _runId: string, deltas: unknown) => {
    written.push({ deltas });
  };
  const fakeScope = { specPath: '/fake', specId: 'myspec', target: { type: 'web' as const } };
  await resolveDecision(
    d.id,
    { resolution_index: 1, scope: 'medium' },
    fakeWriter as never,
    fakeScope as never,
  );
  assert.equal(written.length, 1);
  const delta = (written[0].deltas as Array<{ type: string; content: string }>)[0];
  assert.equal(delta.type, 'observation');
  assert.match(delta.content, /Human ruling on/);
});

test('resolveDecision: broad scope uses playbook type, omits area/behavior', async () => {
  const d = appendDecision({ ...baseDecision, area_id: 'home', behavior_id: 'loads' });
  const written: Array<{ deltas: unknown }> = [];
  const fakeWriter = async (_scope: unknown, _runId: string, deltas: unknown) => {
    written.push({ deltas });
  };
  const fakeScope = { specPath: '/fake', specId: 'myspec', target: { type: 'web' as const } };
  await resolveDecision(
    d.id,
    { resolution_index: 2, scope: 'broad' },
    fakeWriter as never,
    fakeScope as never,
  );
  const delta = (
    written[0].deltas as Array<{ type: string; area_id?: string; behavior_id?: string }>
  )[0];
  assert.equal(delta.type, 'playbook');
  assert.equal(delta.area_id, undefined);
  assert.equal(delta.behavior_id, undefined);
});

test('registerAwaiter: resolveDecision unblocks the awaiter', async () => {
  const d = appendDecision(baseDecision);
  const waitPromise = registerAwaiter(d.id, 5000);
  // resolve concurrently
  const resolvePromise = resolveDecision(d.id, { resolution_index: 0, scope: 'narrow' });
  const [resolved] = await Promise.all([waitPromise, resolvePromise]);
  assert.equal((resolved as PendingDecision).status, 'resolved');
});

test('registerAwaiter: times out when not resolved', async () => {
  const d = appendDecision(baseDecision);
  await assert.rejects(registerAwaiter(d.id, 50), /timeout/);
});
