import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inbox, __setRunnerForTesting } from './inbox.js';
import { saveMessage, loadMessages } from './inbox-state.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';
import { eventBus } from '../agent/event-bus.js';

const ENV_KEYS = [
  'SPECIFY_SPEC_INLINE_PATH',
  'SPECIFY_SPEC_URL',
  'SPECIFY_SPEC_URL_BEARER_FILE',
  'SPECIFY_SPEC_GIT_REPO',
  'SPECIFY_SPEC_GIT_REF',
  'SPECIFY_SPEC_GIT_PATH',
  'SPECIFY_SPEC_GIT_DEPLOY_KEY_FILE',
  'SPECIFY_TARGET_URL',
] as const;

/**
 * Fake runner that records the options it received and returns a
 * deterministic success result. Lets us exercise the full dispatch path
 * without spinning up Playwright or the Agent SDK.
 */
function makeFakeRunner(onCall?: (opts: SdkRunnerOptions) => void) {
  const calls: SdkRunnerOptions[] = [];
  const runner = async (opts: SdkRunnerOptions): Promise<SdkRunnerResult> => {
    calls.push(opts);
    onCall?.(opts);
    return {
      result: 'ok',
      costUsd: 0.01,
      structuredOutput: { pass: true, summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, results: [], test_files: [] },
    };
  };
  return { runner, calls };
}

async function flush(): Promise<void> {
  // Give the microtask/timer queue a tick so dispatched runners settle.
  await new Promise((r) => setTimeout(r, 10));
}

// ---------------------------------------------------------------------------
// Test isolation: redirect disk persistence to a fresh tmpdir so tests never
// write into .specify/inbox/_registry in the source tree.
// ---------------------------------------------------------------------------
let _stateDir: string;
let _envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  _stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-test-'));
  process.env.SPECIFY_INBOX_STATE_DIR = _stateDir;
  _envSnapshot = {};
  for (const key of ENV_KEYS) {
    _envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  delete process.env.SPECIFY_INBOX_STATE_DIR;
  for (const key of ENV_KEYS) {
    const value = _envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(_stateDir, { recursive: true, force: true });
});

function writeMinimalSpec(dir: string, targetUrl = 'http://localhost:3000'): string {
  const specPath = path.join(dir, 'spec.yaml');
  fs.writeFileSync(specPath, [
    'version: "2"',
    'name: Test',
    'description: Test spec.',
    'target:',
    '  type: web',
    `  url: ${targetUrl}`,
    'areas:',
    '  - id: home',
    '    name: Home',
    '    behaviors:',
    '      - id: loads',
    '        description: Page loads.',
    '',
  ].join('\n'));
  return specPath;
}

function minimalSpecYaml(name: string, targetUrl: string): string {
  return [
    'version: "2"',
    `name: ${name}`,
    'description: Test spec.',
    'target:',
    '  type: web',
    `  url: ${targetUrl}`,
    'areas:',
    '  - id: home',
    '    name: Home',
    '    behaviors:',
    '      - id: loads',
    '        description: Page loads.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Existing tests (behaviour unchanged)
// ---------------------------------------------------------------------------

test('inbox.submit stateless: runs fake runner and persists result', async () => {
  inbox.reset();
  const { runner, calls } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-'));
    const specPath = writeMinimalSpec(tmpDir);

    const msg = inbox.submit({
      task: 'verify',
      prompt: 'Verify this.',
      spec: specPath,
      url: 'http://localhost:3000',
      outputDir: path.join(tmpDir, 'out'),
    });
    assert.ok(msg.id.startsWith('msg_'));

    await flush();

    const finished = inbox.get(msg.id)!;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.result?.result, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'verify');
    assert.match(calls[0].systemPrompt, /verification agent/i);

    // Persisted on disk
    assert.ok(finished.resultPath && fs.existsSync(finished.resultPath));
    const saved = JSON.parse(fs.readFileSync(finished.resultPath!, 'utf-8'));
    assert.equal(saved.task, 'verify');
    assert.equal(saved.structuredOutput.pass, true);
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit verify without spec fails', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const msg = inbox.submit({ task: 'verify', prompt: 'hi' });
    await flush();
    const finished = inbox.get(msg.id)!;
    assert.equal(finished.status, 'failed');
    assert.match(finished.error ?? '', /requires `spec`/);
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit verify without request spec falls back to SPECIFY_SPEC_INLINE_PATH', async () => {
  inbox.reset();
  const { runner, calls } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-env-spec-'));
    const specPath = writeMinimalSpec(tmpDir, 'http://from-inline-spec:3000');
    process.env.SPECIFY_SPEC_INLINE_PATH = specPath;

    const msg = inbox.submit({
      task: 'verify',
      prompt: '',
      outputDir: path.join(tmpDir, 'out'),
    });
    await flush();

    const finished = inbox.get(msg.id)!;
    assert.equal(finished.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].spec, path.resolve(specPath));
    assert.match(calls[0].systemPrompt, /from-inline-spec/);
    assert.equal(calls[0].userPrompt, 'Verify http://from-inline-spec:3000 against the behavioral spec.');
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit verify without request spec resolves SPECIFY_SPEC_URL', async () => {
  inbox.reset();
  const { runner, calls } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  const prevFetch = globalThis.fetch;
  try {
    const specUrl = 'https://example.test/.well-known/specify.spec.yaml';
    process.env.SPECIFY_SPEC_URL = specUrl;
    let fetchedUrl = '';
    globalThis.fetch = (async (input) => {
      fetchedUrl = String(input);
      return new Response(minimalSpecYaml('UrlSpec', 'http://from-url-spec:3000'));
    }) as typeof fetch;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-url-spec-'));
    const msg = inbox.submit({
      task: 'verify',
      prompt: '',
      outputDir: path.join(tmpDir, 'out'),
    });
    await flush();

    const finished = inbox.get(msg.id)!;
    assert.equal(finished.status, 'completed');
    assert.equal(fetchedUrl, specUrl);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].spec, undefined);
    assert.match(calls[0].systemPrompt, /UrlSpec/);
    assert.equal(calls[0].userPrompt, 'Verify http://from-url-spec:3000 against the behavioral spec.');
  } finally {
    globalThis.fetch = prevFetch;
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit stateless: serializes concurrent submits', async () => {
  inbox.reset();
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const runner = async (opts: SdkRunnerOptions): Promise<SdkRunnerResult> => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(opts.userPrompt);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { result: 'ok', costUsd: 0 };
  };
  const prev = __setRunnerForTesting(runner);
  try {
    const a = inbox.submit({ task: 'freeform', prompt: 'first' });
    const b = inbox.submit({ task: 'freeform', prompt: 'second' });
    const c = inbox.submit({ task: 'freeform', prompt: 'third' });

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(inbox.get(a.id)?.status, 'completed');
    assert.equal(inbox.get(b.id)?.status, 'completed');
    assert.equal(inbox.get(c.id)?.status, 'completed');
    assert.equal(maxActive, 1, 'stateless runs must not overlap');
    assert.deepEqual(order, ['first', 'second', 'third']);
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit: SPECIFY_TARGET_URL fills in url when caller omits it', async () => {
  inbox.reset();
  const { runner, calls } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  const prevEnv = process.env.SPECIFY_TARGET_URL;
  process.env.SPECIFY_TARGET_URL = 'http://envapp.svc.cluster.local:8080';
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-env-'));
    const specPath = path.join(tmpDir, 'spec.yaml');
    fs.writeFileSync(specPath, [
      'version: "2"',
      'name: Test',
      'target:',
      '  type: web',
      '  url: http://spec-default:3000',
      'areas:',
      '  - id: home',
      '    name: Home',
      '    behaviors:',
      '      - id: loads',
      '        description: Loads.',
      '',
    ].join('\n'));
    inbox.submit({
      task: 'verify',
      prompt: 'Verify after rollout.',
      spec: specPath,
      sender: 'k8s-watcher',
      outputDir: path.join(tmpDir, 'out'),
    });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://envapp.svc.cluster.local:8080');
  } finally {
    if (prevEnv === undefined) delete process.env.SPECIFY_TARGET_URL;
    else process.env.SPECIFY_TARGET_URL = prevEnv;
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit: explicit url wins over SPECIFY_TARGET_URL', async () => {
  inbox.reset();
  const { runner, calls } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  const prevEnv = process.env.SPECIFY_TARGET_URL;
  process.env.SPECIFY_TARGET_URL = 'http://from-env';
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-env-'));
    const specPath = path.join(tmpDir, 'spec.yaml');
    fs.writeFileSync(specPath, [
      'version: "2"',
      'name: Test',
      'target: { type: web, url: http://spec:3000 }',
      'areas: [{ id: home, name: Home, behaviors: [{ id: loads, description: Loads. }] }]',
      '',
    ].join('\n'));
    inbox.submit({
      task: 'verify',
      prompt: 'Verify explicit url.',
      spec: specPath,
      url: 'http://caller-url',
      outputDir: path.join(tmpDir, 'out'),
    });
    await flush();
    assert.equal(calls[0].url, 'http://caller-url');
  } finally {
    if (prevEnv === undefined) delete process.env.SPECIFY_TARGET_URL;
    else process.env.SPECIFY_TARGET_URL = prevEnv;
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.list returns newest first', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const a = inbox.submit({ task: 'freeform', prompt: 'one' });
    await new Promise((r) => setTimeout(r, 5));
    const b = inbox.submit({ task: 'freeform', prompt: 'two' });
    await flush();
    const list = inbox.list();
    assert.equal(list[0].id, b.id);
    assert.equal(list[1].id, a.id);
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

// ---------------------------------------------------------------------------
// New persistence tests
// ---------------------------------------------------------------------------

test('inbox.submit: record is persisted to disk immediately after submit() (queued or running)', () => {
  // submit() synchronously calls persist() with status='queued', then
  // asynchronously dispatches. By the time loadMessages() runs synchronously
  // here, the record is on disk — it may already have advanced to 'running'
  // if the microtask queue ran, but it will always be present.
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const msg = inbox.submit({ task: 'freeform', prompt: 'persist-me' });
    const records = loadMessages();
    const found = records.find((r) => r.id === msg.id);
    assert.ok(found, 'record should be on disk immediately after submit');
    // Status is either 'queued' (persisted synchronously) or 'running'
    // (dispatch started before loadMessages ran — both are acceptable).
    assert.ok(
      found?.status === 'queued' || found?.status === 'running',
      `expected queued or running, got ${found?.status}`,
    );
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.submit: after completion the disk record has status completed', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const msg = inbox.submit({ task: 'freeform', prompt: 'complete-me' });
    await flush();

    assert.equal(inbox.get(msg.id)?.status, 'completed');

    const records = loadMessages();
    const found = records.find((r) => r.id === msg.id);
    assert.ok(found, 'completed record should be on disk');
    assert.equal(found?.status, 'completed');
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('inbox.restoreFromDisk: running/queued → interrupted; completed unchanged', async () => {
  // Seed the state dir directly with JSON files (bypassing submit) to
  // simulate records left from a previous pod lifetime, then call
  // restoreFromDisk() on a freshly-reset registry.

  inbox.reset(); // clears in-memory history

  const runningMsg = {
    id: 'msg_restore01',
    createdAt: new Date(Date.now() - 5000).toISOString(),
    status: 'running' as const,
    request: { task: 'freeform' as const, prompt: 'was running' },
  };
  const queuedMsg = {
    id: 'msg_restore02',
    createdAt: new Date(Date.now() - 3000).toISOString(),
    status: 'queued' as const,
    request: { task: 'freeform' as const, prompt: 'was queued' },
  };
  const completedMsg = {
    id: 'msg_restore03',
    createdAt: new Date(Date.now() - 1000).toISOString(),
    status: 'completed' as const,
    request: { task: 'freeform' as const, prompt: 'was completed' },
    result: { result: 'ok', costUsd: 0.01 },
  };

  saveMessage(runningMsg);
  saveMessage(queuedMsg);
  saveMessage(completedMsg);

  // Reset in-memory state to simulate a fresh daemon start (disk is intact).
  inbox.reset();

  const { restored, interrupted } = inbox.restoreFromDisk();

  assert.equal(restored, 3, 'should restore 3 records');
  assert.equal(interrupted, 2, 'running + queued should be marked interrupted');

  // running → interrupted
  const r1 = inbox.get('msg_restore01');
  assert.ok(r1, 'running record should be in history after restore');
  assert.equal(r1?.status, 'interrupted');
  assert.match(r1?.error ?? '', /restarted/i);

  // queued → interrupted
  const r2 = inbox.get('msg_restore02');
  assert.ok(r2, 'queued record should be in history after restore');
  assert.equal(r2?.status, 'interrupted');
  assert.match(r2?.error ?? '', /restarted/i);

  // completed → still completed, no error injected
  const r3 = inbox.get('msg_restore03');
  assert.ok(r3, 'completed record should be in history after restore');
  assert.equal(r3?.status, 'completed');
  assert.equal(r3?.error, undefined);

  // disk records for interrupted jobs should also be updated
  const diskRecords = loadMessages();
  const diskR1 = diskRecords.find((r) => r.id === 'msg_restore01');
  assert.equal(diskR1?.status, 'interrupted', 'disk record should be updated to interrupted');

  inbox.reset();
});

test('inbox.restoreFromDisk: empty state dir returns 0/0', () => {
  inbox.reset();
  const { restored, interrupted } = inbox.restoreFromDisk();
  assert.equal(restored, 0);
  assert.equal(interrupted, 0);
  inbox.reset();
});

// ---------------------------------------------------------------------------
// Timestamp tests
// ---------------------------------------------------------------------------

test('inbox:completed event carries startedAt and completedAt ISO strings', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-ts-'));
    const specPath = writeMinimalSpec(tmpDir);

    let completedEvent: Record<string, unknown> | undefined;
    const unsub = eventBus.onAny((ev) => {
      if (ev.type === 'inbox:completed') {
        completedEvent = ev.data as Record<string, unknown>;
      }
    });

    const before = new Date().toISOString();
    const msg = inbox.submit({
      task: 'verify',
      prompt: 'Verify.',
      spec: specPath,
      outputDir: path.join(tmpDir, 'out'),
    });
    await flush();
    const after = new Date().toISOString();
    unsub();

    assert.ok(completedEvent, 'inbox:completed event should have fired');
    assert.equal(completedEvent!.id, msg.id);

    const startedAt = completedEvent!.startedAt as string;
    const completedAt = completedEvent!.completedAt as string;
    assert.ok(typeof startedAt === 'string', 'startedAt should be a string');
    assert.ok(typeof completedAt === 'string', 'completedAt should be a string');
    // Timestamps should be valid ISO-8601 and within the test window.
    assert.ok(startedAt >= before, `startedAt ${startedAt} should be >= ${before}`);
    assert.ok(completedAt <= after, `completedAt ${completedAt} should be <= ${after}`);
    assert.ok(startedAt <= completedAt, 'startedAt should be <= completedAt');

    // Also verify they are stamped on the persisted message.
    const finished = inbox.get(msg.id)!;
    assert.equal(finished.startedAt, startedAt);
    assert.equal(finished.completedAt, completedAt);
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

// ---------------------------------------------------------------------------
// SP-mn7: findActiveVerify tests
// ---------------------------------------------------------------------------

test('findActiveVerify: queued verify with matching metadata → found', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-fav-'));
    const specPath = writeMinimalSpec(tmpDir);

    // Submit a verify that will sit 'queued' (runner is async, not started yet).
    const msg = inbox.submit({
      task: 'verify',
      prompt: 'Verify api rollout.',
      spec: specPath,
      outputDir: path.join(tmpDir, 'out'),
      metadata: {
        kind: 'deployment',
        namespace: 'staging',
        name: 'api',
        image: 'api:1.2.3',
      },
    });

    // Status may be 'queued' or 'running' — either is 'active'.
    const found = inbox.findActiveVerify({ namespace: 'staging', name: 'api', image: 'api:1.2.3' });
    assert.ok(found, 'should find the active verify');
    assert.equal(found?.id, msg.id);

    await flush();

    // After completion, it should NOT be found.
    const notFound = inbox.findActiveVerify({ namespace: 'staging', name: 'api', image: 'api:1.2.3' });
    assert.equal(notFound, undefined, 'completed verify should not be returned');
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('findActiveVerify: image mismatch on both sides → not found', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-fav2-'));
    const specPath = writeMinimalSpec(tmpDir);

    inbox.submit({
      task: 'verify',
      prompt: 'Verify.',
      spec: specPath,
      outputDir: path.join(tmpDir, 'out'),
      metadata: { kind: 'deployment', namespace: 'staging', name: 'api', image: 'api:1' },
    });

    // Different image on both sides — should not match.
    const found = inbox.findActiveVerify({ namespace: 'staging', name: 'api', image: 'api:2' });
    assert.equal(found, undefined, 'different images should not match');

    await flush();
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('findActiveVerify: image missing on one side → found (partial match)', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-fav3-'));
    const specPath = writeMinimalSpec(tmpDir);

    // Message has an image in metadata.
    inbox.submit({
      task: 'verify',
      prompt: 'Verify.',
      spec: specPath,
      outputDir: path.join(tmpDir, 'out'),
      metadata: { kind: 'deployment', namespace: 'staging', name: 'api', image: 'api:1' },
    });

    // Target has NO image — should still match on namespace+name.
    const found = inbox.findActiveVerify({ namespace: 'staging', name: 'api' });
    assert.ok(found, 'should match when target has no image');

    // Conversely: message has no image, target has one → also match.
    inbox.reset();
    inbox.submit({
      task: 'verify',
      prompt: 'Verify.',
      spec: specPath,
      outputDir: path.join(tmpDir, 'out2'),
      metadata: { kind: 'deployment', namespace: 'staging', name: 'api' },
    });
    const found2 = inbox.findActiveVerify({ namespace: 'staging', name: 'api', image: 'api:1' });
    assert.ok(found2, 'should match when message metadata has no image');

    await flush();
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});

test('findActiveVerify: url-based match (no metadata) → found; non-verify → not found', async () => {
  inbox.reset();
  const { runner } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-fav4-'));
    const specPath = writeMinimalSpec(tmpDir);

    // A deploy-script style verify: has url, no metadata.
    inbox.submit({
      task: 'verify',
      prompt: 'Verify after deploy.',
      spec: specPath,
      url: 'http://myapp.svc.cluster.local:8080',
      outputDir: path.join(tmpDir, 'out'),
    });

    // Should be found by effectiveUrl.
    const found = inbox.findActiveVerify(
      { namespace: 'prod', name: 'myapp' },
      'http://myapp.svc.cluster.local:8080',
    );
    assert.ok(found, 'should find by effectiveUrl');

    // Non-verify task should NOT match.
    inbox.reset();
    inbox.submit({
      task: 'capture',
      prompt: 'Capture.',
      url: 'http://myapp.svc.cluster.local:8080',
      outputDir: path.join(tmpDir, 'out2'),
    });
    const notFound = inbox.findActiveVerify(
      { namespace: 'prod', name: 'myapp' },
      'http://myapp.svc.cluster.local:8080',
    );
    assert.equal(notFound, undefined, 'non-verify task should not match');

    await flush();
  } finally {
    __setRunnerForTesting(prev);
    inbox.reset();
  }
});
