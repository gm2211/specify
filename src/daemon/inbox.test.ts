import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inbox, __setRunnerForTesting } from './inbox.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';

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

test('inbox.submit stateless: runs fake runner and persists result', async () => {
  inbox.reset();
  const { runner, calls } = makeFakeRunner();
  const prev = __setRunnerForTesting(runner);
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-'));
    const specPath = path.join(tmpDir, 'spec.yaml');
    fs.writeFileSync(specPath, [
      'version: "2"',
      'name: Test',
      'description: Test spec.',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - id: home',
      '    name: Home',
      '    behaviors:',
      '      - id: loads',
      '        description: Page loads.',
    ].join('\n'));

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
