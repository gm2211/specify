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
 *   - Platform sink (rnz-tol9):
 *                 PLATFORM_SPEC_RUN_RESULT_URL=https://resident.getrenzo.ai/api/platform/dev/spec-run-result
 *                 PLATFORM_SPECIFY_TOKEN=<bearer>
 *                 → After each verify run completes, POSTs area-level results
 *                 array to the platform endpoint so the developer dashboard can
 *                 surface pass/fail timelines. The first entry in the array
 *                 carries run-level timestamps (startedAt / completedAt, ISO-8601)
 *                 when available. Fire-and-forget; failure is logged but never
 *                 fatal to the verify run itself.
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
  /** ISO-8601 timestamp when the job began executing (run-level). */
  startedAt?: string;
  /** ISO-8601 timestamp when the job finished (run-level). */
  completedAt?: string;
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
  /**
   * When both are set, platform sink POSTs area-level results to the Renzo
   * platform spec-run-result endpoint (rnz-tol9).
   * Set via PLATFORM_SPEC_RUN_RESULT_URL + PLATFORM_SPECIFY_TOKEN env vars.
   */
  platformSpecRunResultUrl?: string;
  platformSpecifyToken?: string;
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
    platformSpecRunResultUrl: env.PLATFORM_SPEC_RUN_RESULT_URL || undefined,
    platformSpecifyToken: env.PLATFORM_SPECIFY_TOKEN || undefined,
  };
}

export function buildSinks(config: SinkConfig, fetchImpl: typeof fetch = globalThis.fetch): ReportSink[] {
  const sinks: ReportSink[] = [];
  if (config.fileDir) sinks.push(fileSink(config.fileDir));
  if (config.slackWebhookFile) sinks.push(slackSink(config.slackWebhookFile, fetchImpl));
  if (config.platformSpecRunResultUrl && config.platformSpecifyToken) {
    sinks.push(platformSink(config.platformSpecRunResultUrl, config.platformSpecifyToken, fetchImpl));
  }
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

// ---------------------------------------------------------------------------
// Platform sink (rnz-tol9) — POST area-level results to platform spec-run-result
// ---------------------------------------------------------------------------

/** Shape the specify agent emits for each per-behavior result in structuredOutput. */
interface BehaviorResult {
  id: string;          // "area-id/behavior-id"
  status: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  rationale?: string;
}

/** Shape the platform POST body expects. */
interface PlatformRunEntry {
  area: string;
  passed: boolean;
  /** Sum of known per-behavior durations (ms). Omitted when no behavior reported timing — receiver stores null. */
  durationMs?: number;
  errorMessage?: string;
  /** ISO-8601 timestamp when the run began. Only set on the first entry of the array (run-level, per receiver contract). */
  startedAt?: string;
  /** ISO-8601 timestamp when the run finished. Only set on the first entry of the array (run-level, per receiver contract). */
  completedAt?: string;
}

interface VerifyStructuredOutputFull {
  pass?: boolean;
  summary?: { total: number; passed: number; failed: number; skipped: number };
  results?: BehaviorResult[];
}

/**
 * Aggregate per-behavior results into area-level entries for the platform API.
 *
 * The verify output uses "area-id/behavior-id" as the behavior id. We split on
 * the first "/" to derive the area key, then roll up: an area passes iff all
 * non-skipped behaviors in it pass. Duration = sum of known per-behavior durations
 * (omitted entirely when no behavior in the area reported timing — receiver stores
 * null and renders "—" instead of 0ms). errorMessage = first failing rationale
 * (truncated), if any.
 */
function aggregateToAreaEntries(body: unknown): PlatformRunEntry[] {
  const so =
    body && typeof body === 'object' && 'structuredOutput' in body
      ? (body as { structuredOutput?: VerifyStructuredOutputFull }).structuredOutput
      : (body as VerifyStructuredOutputFull | undefined);

  const results = so?.results;
  if (!Array.isArray(results) || results.length === 0) return [];

  const areaMap = new Map<string, { totalMs: number; hasTiming: boolean; failed: boolean; firstError?: string }>();

  for (const r of results) {
    if (r.status === 'skipped') continue;
    const slashIdx = r.id.indexOf('/');
    const area = slashIdx > 0 ? r.id.slice(0, slashIdx) : r.id;

    const existing = areaMap.get(area);
    const hasDuration = typeof r.duration_ms === 'number';
    const durationMs = hasDuration ? r.duration_ms! : 0;
    const failed = r.status === 'failed';

    if (!existing) {
      areaMap.set(area, {
        totalMs: durationMs,
        hasTiming: hasDuration,
        failed,
        firstError: failed && r.rationale ? r.rationale.slice(0, 500) : undefined,
      });
    } else {
      if (hasDuration) {
        existing.totalMs += durationMs;
        existing.hasTiming = true;
      }
      if (failed) {
        existing.failed = true;
        if (!existing.firstError && r.rationale) {
          existing.firstError = r.rationale.slice(0, 500);
        }
      }
    }
  }

  return Array.from(areaMap.entries()).map(([area, data]) => ({
    area,
    passed: !data.failed,
    ...(data.hasTiming ? { durationMs: Math.round(data.totalMs) } : {}),
    ...(data.firstError ? { errorMessage: data.firstError } : {}),
  }));
}

function platformSink(url: string, token: string, fetchImpl: typeof fetch): ReportSink {
  return {
    name: 'platform',
    async send(ctx) {
      const entries = aggregateToAreaEntries(ctx.body);
      if (entries.length === 0) {
        // Verify run produced no behavior results (capture, compare, etc.) — skip.
        return;
      }
      // Merge run-level timestamps onto the first entry (per receiver contract:
      // devSpecRunsIngest.ts reads startedAt/completedAt from entries[0]).
      if (ctx.startedAt || ctx.completedAt) {
        entries[0] = {
          ...entries[0],
          ...(ctx.startedAt ? { startedAt: ctx.startedAt } : {}),
          ...(ctx.completedAt ? { completedAt: ctx.completedAt } : {}),
        };
      }
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-specify-token': token,
        },
        body: JSON.stringify(entries),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`platform spec-run-result ${res.status}: ${text.slice(0, 200)}`);
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
    const startedAt = typeof ev.data.startedAt === 'string' ? ev.data.startedAt : undefined;
    const completedAt = typeof ev.data.completedAt === 'string' ? ev.data.completedAt : undefined;
    void dispatch({ id, resultPath, costUsd: typeof ev.data.costUsd === 'number' ? ev.data.costUsd : undefined, startedAt, completedAt }, sinks);
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
