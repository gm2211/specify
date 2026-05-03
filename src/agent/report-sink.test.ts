import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  attachReportSinks,
  buildSinks,
  sinkConfigFromEnv,
} from './report-sink.js';
import { eventBus } from './event-bus.js';

function tmp(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-sink-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('sinkConfigFromEnv: pulls dir + slack webhook file from env', () => {
  assert.deepEqual(
    sinkConfigFromEnv({
      SPECIFY_REPORT_FILE_DIR: '/work/reports',
      SPECIFY_REPORT_SLACK_WEBHOOK_FILE: '/run/secrets/slack',
    }),
    { fileDir: '/work/reports', slackWebhookFile: '/run/secrets/slack' },
  );
});

test('sinkConfigFromEnv: empty when nothing set', () => {
  assert.deepEqual(sinkConfigFromEnv({}), { fileDir: undefined, slackWebhookFile: undefined });
});

test('buildSinks: empty config → no sinks', () => {
  assert.equal(buildSinks({}).length, 0);
});

test('file sink: writes <id>.json with re-serialized body', async () => {
  const { dir, cleanup } = tmp();
  try {
    const sinks = buildSinks({ fileDir: dir });
    assert.equal(sinks.length, 1);
    await sinks[0].send({
      id: 'msg_abc',
      resultPath: '/dev/null',
      body: { task: 'verify', structuredOutput: { passed: 3, failed: 1, total: 4 } },
    });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'msg_abc.json'), 'utf-8'));
    assert.equal(written.task, 'verify');
    assert.equal(written.structuredOutput.passed, 3);
  } finally {
    cleanup();
  }
});

test('slack sink: posts JSON payload, wraps non-OK as Error', async () => {
  const { dir, cleanup } = tmp();
  try {
    const webhookFile = path.join(dir, 'webhook');
    fs.writeFileSync(webhookFile, 'https://hooks.slack.com/T/B/X');
    let posted: { url?: string; payload?: unknown } = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      posted = { url, payload: JSON.parse(init?.body as string) };
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const sinks = buildSinks({ slackWebhookFile: webhookFile }, fetchImpl);
    await sinks[0].send({
      id: 'msg_xyz',
      resultPath: '/dev/null',
      body: { structuredOutput: { passed: 5, failed: 0, total: 5 } },
      costUsd: 0.1234,
    });
    assert.equal(posted.url, 'https://hooks.slack.com/T/B/X');
    const p = posted.payload as { text: string; attachments: Array<{ color: string; fields: Array<{ title: string; value: string }> }> };
    assert.match(p.text, /all 5 behaviors passing/);
    assert.equal(p.attachments[0].color, 'good');
    assert.ok(p.attachments[0].fields.some((f) => f.title === 'Cost' && f.value === '$0.1234'));
  } finally {
    cleanup();
  }
});

test('slack sink: failed status surfaces error', async () => {
  const { dir, cleanup } = tmp();
  try {
    const webhookFile = path.join(dir, 'webhook');
    fs.writeFileSync(webhookFile, 'https://x');
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const sinks = buildSinks({ slackWebhookFile: webhookFile }, fetchImpl);
    await assert.rejects(
      sinks[0].send({ id: 'm', resultPath: '/dev/null', body: {} }),
      /Slack webhook 429/,
    );
  } finally {
    cleanup();
  }
});

test('slack sink: failure color when behaviors failed', async () => {
  const { dir, cleanup } = tmp();
  try {
    const webhookFile = path.join(dir, 'webhook');
    fs.writeFileSync(webhookFile, 'https://x');
    let payload: { attachments: Array<{ color: string }>; text: string } = { attachments: [], text: '' };
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      payload = JSON.parse(init?.body as string);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const sinks = buildSinks({ slackWebhookFile: webhookFile }, fetchImpl);
    await sinks[0].send({
      id: 'm',
      resultPath: '/dev/null',
      body: { structuredOutput: { passed: 2, failed: 3, total: 5 } },
    });
    assert.equal(payload.attachments[0].color, 'danger');
    assert.match(payload.text, /3\/5 behaviors failing/);
  } finally {
    cleanup();
  }
});

test('attachReportSinks: bus event triggers file write end-to-end', async () => {
  const { dir, cleanup } = tmp();
  try {
    const reportsDir = path.join(dir, 'reports');
    const resultPath = path.join(dir, 'verify-result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ task: 'verify', structuredOutput: { passed: 1, failed: 0, total: 1 } }),
    );
    const { sinks, detach } = attachReportSinks({ config: { fileDir: reportsDir } });
    assert.equal(sinks.length, 1);
    try {
      eventBus.send('inbox:completed', { id: 'msg_e2e', resultPath, costUsd: 0.05 });
      // Sinks fire async; give the microtask queue a tick.
      await new Promise((r) => setTimeout(r, 30));
      const written = JSON.parse(fs.readFileSync(path.join(reportsDir, 'msg_e2e.json'), 'utf-8'));
      assert.equal(written.structuredOutput.passed, 1);
    } finally {
      detach();
    }
  } finally {
    cleanup();
  }
});

test('attachReportSinks: ignores events of other types', async () => {
  const { dir, cleanup } = tmp();
  try {
    const reportsDir = path.join(dir, 'reports');
    const { detach } = attachReportSinks({ config: { fileDir: reportsDir } });
    try {
      eventBus.send('inbox:running', { id: 'whatever' });
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(!fs.existsSync(path.join(reportsDir, 'whatever.json')));
    } finally {
      detach();
    }
  } finally {
    cleanup();
  }
});
