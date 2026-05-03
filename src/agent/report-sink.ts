/**
 * src/agent/report-sink.ts — Pluggable outbound publisher for verify reports.
 *
 * The QA pod runs a daemon that completes verify tasks asynchronously. After
 * each completion, the daemon emits an `inbox:completed` event with the
 * persisted result-file path. This module subscribes to those events and
 * fans them out to configured "sinks" — file copies, chat webhooks, future
 * GitHub Check publishers, etc.
 *
 * Sinks are env-configured for v1 (no yaml — easy to wire from Terraform):
 *
 *   - File sink:  SPECIFY_REPORT_FILE_DIR=/work/reports
 *                 → on completion, copies the result JSON into the dir,
 *                 named <id>.json so it's chronologically sortable.
 *   - Slack sink: SPECIFY_REPORT_SLACK_WEBHOOK_FILE=/run/secrets/slack-webhook
 *                 → POSTs a compact summary to the webhook URL read from the
 *                 file. (File-mounted, not env-var-mounted, so it survives
 *                 secret rotation without pod restart.)
 *
 * `attachReportSinks()` wires the subscription; the returned function
 * detaches when called (mostly for tests). Production code attaches once
 * at daemon start and never detaches.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpecifyEvent } from './event-bus.js';
import { eventBus } from './event-bus.js';

export interface ReportContext {
  /** Inbox message id that produced this report. */
  id: string;
  /** Path of the persisted result JSON on disk. */
  resultPath: string;
  /** Cost in USD if reported by the run. */
  costUsd?: number;
  /** Loaded result body (parsed JSON). */
  body: unknown;
}

export interface ReportSink {
  name: string;
  send(ctx: ReportContext): Promise<void>;
}

export interface SinkConfig {
  /** When set, file sink writes a copy of each result here. */
  fileDir?: string;
  /** When set, slack sink POSTs a summary to the webhook URL inside this file. */
  slackWebhookFile?: string;
}

export interface AttachOptions {
  config?: SinkConfig;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Skip subscribing to the event bus and just return the sinks (testing). */
  detached?: boolean;
}

export function sinkConfigFromEnv(env: Record<string, string | undefined> = process.env): SinkConfig {
  return {
    fileDir: env.SPECIFY_REPORT_FILE_DIR,
    slackWebhookFile: env.SPECIFY_REPORT_SLACK_WEBHOOK_FILE,
  };
}

export function buildSinks(config: SinkConfig, fetchImpl: typeof fetch = globalThis.fetch): ReportSink[] {
  const sinks: ReportSink[] = [];
  if (config.fileDir) sinks.push(fileSink(config.fileDir));
  if (config.slackWebhookFile) sinks.push(slackSink(config.slackWebhookFile, fetchImpl));
  return sinks;
}

function fileSink(dir: string): ReportSink {
  return {
    name: 'file',
    async send(ctx) {
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${ctx.id}.json`);
      // Re-serialize the parsed body so we get a stable, formatted copy
      // even if the source result file format changes shape.
      fs.writeFileSync(dest, JSON.stringify(ctx.body, null, 2), 'utf-8');
    },
  };
}

interface VerifyStructuredOutput {
  passed?: number;
  failed?: number;
  total?: number;
  passRate?: number;
  status?: string;
  summary?: string;
}

function summarizeForSlack(body: unknown): { text: string; pass: number; fail: number; total: number } {
  // Match the loose shape persistResult writes: { id, task, structuredOutput }
  const so =
    (body && typeof body === 'object' && 'structuredOutput' in body
      ? (body as { structuredOutput?: VerifyStructuredOutput }).structuredOutput
      : (body as VerifyStructuredOutput | undefined)) ?? {};
  const pass = Number(so.passed ?? 0) || 0;
  const fail = Number(so.failed ?? 0) || 0;
  const total = Number(so.total ?? pass + fail) || pass + fail;
  const rate = total > 0 ? Math.round((pass / total) * 100) : 0;
  const headline =
    total === 0
      ? 'specify run completed (no behaviors verified)'
      : fail === 0
        ? `specify run: all ${total} behaviors passing`
        : `specify run: ${fail}/${total} behaviors failing (${rate}% pass)`;
  const summary = so.summary ? `\n${so.summary}` : '';
  return { text: headline + summary, pass, fail, total };
}

function slackSink(webhookFile: string, fetchImpl: typeof fetch): ReportSink {
  return {
    name: 'slack',
    async send(ctx) {
      if (!fs.existsSync(webhookFile)) {
        throw new Error(`Slack webhook file not found: ${webhookFile}`);
      }
      const url = fs.readFileSync(webhookFile, 'utf-8').trim();
      if (!url) throw new Error('Slack webhook file is empty');
      const { text, pass, fail, total } = summarizeForSlack(ctx.body);
      const payload = {
        text,
        attachments: [
          {
            color: fail === 0 ? 'good' : 'danger',
            fields: [
              { title: 'Pass', value: String(pass), short: true },
              { title: 'Fail', value: String(fail), short: true },
              { title: 'Total', value: String(total), short: true },
              ...(ctx.costUsd != null
                ? [{ title: 'Cost', value: `$${ctx.costUsd.toFixed(4)}`, short: true }]
                : []),
              { title: 'Run', value: ctx.id, short: false },
            ],
          },
        ],
      };
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Slack webhook ${res.status}: ${body.slice(0, 200)}`);
      }
    },
  };
}

export interface AttachResult {
  sinks: ReportSink[];
  detach: () => void;
}

export function attachReportSinks(opts: AttachOptions = {}): AttachResult {
  const cfg = opts.config ?? sinkConfigFromEnv();
  const sinks = buildSinks(cfg, opts.fetchImpl ?? globalThis.fetch);
  if (opts.detached || sinks.length === 0) {
    return { sinks, detach: () => undefined };
  }

  const handler = (ev: SpecifyEvent) => {
    if (ev.type !== 'inbox:completed') return;
    const id = String(ev.data.id ?? '');
    const resultPath = ev.data.resultPath;
    if (!id || typeof resultPath !== 'string' || !resultPath) return;
    void dispatch({ id, resultPath, costUsd: typeof ev.data.costUsd === 'number' ? ev.data.costUsd : undefined }, sinks);
  };
  const detach = eventBus.onAny(handler);
  return { sinks, detach };
}

async function dispatch(meta: Omit<ReportContext, 'body'>, sinks: ReportSink[]): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(fs.readFileSync(meta.resultPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[report-sink] could not read ${meta.resultPath}: ${(err as Error).message}\n`);
    return;
  }
  const ctx: ReportContext = { ...meta, body };
  await Promise.all(
    sinks.map(async (s) => {
      try {
        await s.send(ctx);
      } catch (err) {
        process.stderr.write(`[report-sink:${s.name}] send failed for ${meta.id}: ${(err as Error).message}\n`);
      }
    }),
  );
}
