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
import type { ReportContext } from './report-sink.js';
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
    {
      fileDir: '/work/reports',
      platformSpecRunResultUrl: undefined,
      platformSpecifyToken: undefined,
      slackWebhookFile: '/run/secrets/slack',
    },
  );
});

test('sinkConfigFromEnv: empty when nothing set', () => {
  assert.deepEqual(sinkConfigFromEnv({}), {
    fileDir: undefined,
    platformSpecRunResultUrl: undefined,
    platformSpecifyToken: undefined,
    slackWebhookFile: undefined,
  });
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

// ---------------------------------------------------------------------------
// Platform sink — durationMs and timestamp tests
// ---------------------------------------------------------------------------

function makePlatformSinks(fetchImpl: typeof fetch) {
  return buildSinks(
    {
      platformSpecRunResultUrl: 'https://platform.test/spec-run-result',
      platformSpecifyToken: 'test-token',
    },
    fetchImpl,
  );
}

function makeVerifyBody(results: Array<{ id: string; status: string; duration_ms?: number; rationale?: string }>) {
  return {
    task: 'verify',
    structuredOutput: {
      pass: true,
      summary: { total: results.length, passed: results.filter((r) => r.status === 'passed').length, failed: 0, skipped: 0 },
      results,
    },
  };
}

test('platform sink: area with all untimed behaviors → entry has no durationMs key', async () => {
  let postedBody: unknown;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const sinks = makePlatformSinks(fetchImpl);
  const ctx: ReportContext = {
    id: 'msg_notimed',
    resultPath: '/dev/null',
    body: makeVerifyBody([
      { id: 'home/loads', status: 'passed' },
      { id: 'home/renders', status: 'passed' },
    ]),
  };
  await sinks[0].send(ctx);

  const entries = postedBody as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].area, 'home');
  assert.equal(entries[0].passed, true);
  assert.ok(!('durationMs' in entries[0]), 'durationMs should be absent when no behavior has timing');
});

test('platform sink: area with mixed timing → durationMs equals sum of known durations only', async () => {
  let postedBody: unknown;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const sinks = makePlatformSinks(fetchImpl);
  const ctx: ReportContext = {
    id: 'msg_mixed',
    resultPath: '/dev/null',
    body: makeVerifyBody([
      { id: 'home/loads', status: 'passed', duration_ms: 300 },
      { id: 'home/renders', status: 'passed' },   // no duration_ms
      { id: 'home/nav', status: 'passed', duration_ms: 150 },
    ]),
  };
  await sinks[0].send(ctx);

  const entries = postedBody as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].durationMs, 450, 'durationMs should be sum of the two timed behaviors only');
});

test('platform sink: ctx with startedAt/completedAt → first entry carries them, subsequent entries do not', async () => {
  let postedBody: unknown;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const sinks = makePlatformSinks(fetchImpl);
  const ctx: ReportContext = {
    id: 'msg_ts',
    resultPath: '/dev/null',
    startedAt: '2026-01-01T10:00:00.000Z',
    completedAt: '2026-01-01T10:05:00.000Z',
    body: makeVerifyBody([
      { id: 'home/loads', status: 'passed', duration_ms: 100 },
      { id: 'checkout/flow', status: 'passed', duration_ms: 200 },
    ]),
  };
  await sinks[0].send(ctx);

  const entries = postedBody as Array<Record<string, unknown>>;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].startedAt, '2026-01-01T10:00:00.000Z');
  assert.equal(entries[0].completedAt, '2026-01-01T10:05:00.000Z');
  assert.ok(!('startedAt' in entries[1]), 'startedAt should not appear on subsequent entries');
  assert.ok(!('completedAt' in entries[1]), 'completedAt should not appear on subsequent entries');
});

test('platform sink: ctx without timestamps → no startedAt/completedAt keys in body', async () => {
  let postedBody: unknown;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    postedBody = JSON.parse(init?.body as string);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const sinks = makePlatformSinks(fetchImpl);
  const ctx: ReportContext = {
    id: 'msg_nots',
    resultPath: '/dev/null',
    body: makeVerifyBody([
      { id: 'home/loads', status: 'passed', duration_ms: 100 },
    ]),
  };
  await sinks[0].send(ctx);

  const entries = postedBody as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.ok(!('startedAt' in entries[0]), 'startedAt should be absent when ctx has no timestamps');
  assert.ok(!('completedAt' in entries[0]), 'completedAt should be absent when ctx has no timestamps');
});

test('attachReportSinks: bus event with timestamps propagates to platform sink', async () => {
  const { dir, cleanup } = tmp();
  try {
    const resultPath = path.join(dir, 'verify-result.json');
    fs.writeFileSync(
      resultPath,
      JSON.stringify(makeVerifyBody([{ id: 'home/loads', status: 'passed', duration_ms: 100 }])),
    );

    let postedBody: unknown;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      postedBody = JSON.parse(init?.body as string);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const { detach } = attachReportSinks({
      config: {
        platformSpecRunResultUrl: 'https://platform.test/spec-run-result',
        platformSpecifyToken: 'tok',
      },
      fetchImpl,
    });
    try {
      eventBus.send('inbox:completed', {
        id: 'msg_busTs',
        resultPath,
        costUsd: 0.01,
        startedAt: '2026-06-01T09:00:00.000Z',
        completedAt: '2026-06-01T09:03:00.000Z',
      });
      await new Promise((r) => setTimeout(r, 50));
      const entries = postedBody as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(entries), 'should have posted entries');
      assert.equal(entries[0].startedAt, '2026-06-01T09:00:00.000Z');
      assert.equal(entries[0].completedAt, '2026-06-01T09:03:00.000Z');
    } finally {
      detach();
    }
  } finally {
    cleanup();
  }
});
