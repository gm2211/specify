/**
 * src/agent/feedback-mcp.ts — Outbound ticket-filing tool for the agent.
 *
 * Distinct from src/agent/feedback.ts (which ingests INBOUND feedback from
 * the cooperative-QA webapp). This module exposes an MCP tool the verify
 * agent can call mid-run to file a ticket about something it found —
 * a reproducible bug, a quirk worth a human looking at, a regression
 * across runs.
 *
 * Two sinks ship:
 *
 *   - bd  (default): shells out to `bd create` with the right type +
 *          priority. Lives next to specify state on the same machine.
 *   - http: POSTs to SPECIFY_FEEDBACK_URL with optional bearer from
 *          SPECIFY_FEEDBACK_BEARER_FILE. Wire to Linear/Jira/GitHub
 *          Issues via a tiny adapter on the consumer side.
 *
 * The agent should reach for this tool sparingly: only when the issue is
 * reproducible and worth a human looking at. Memory rows still cover
 * "lesson learned" / "always probe X" cases via memory_record.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { eventBus } from './event-bus.js';

export type FeedbackSink =
  | { kind: 'bd' }
  | { kind: 'http'; url: string; bearerFile?: string };

export interface FeedbackMcpContext {
  specId: string;
  runId: string;
  sink: FeedbackSink;
  /** Override `bd` exec for tests. */
  bdExec?: (args: string[]) => Promise<{ stdout: string; code: number | null }>;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export function feedbackSinkFromEnv(env: Record<string, string | undefined> = process.env): FeedbackSink {
  if (env.SPECIFY_FEEDBACK_URL) {
    return {
      kind: 'http',
      url: env.SPECIFY_FEEDBACK_URL,
      bearerFile: env.SPECIFY_FEEDBACK_BEARER_FILE,
    };
  }
  return { kind: 'bd' };
}

export function createFeedbackMcpServer(ctx: FeedbackMcpContext) {
  return createSdkMcpServer({
    name: 'feedback',
    tools: [
      tool(
        'file_ticket',
        [
          'File a ticket for a reproducible problem found during this verify run.',
          'Use only for issues a human should look at — bugs, regressions, broken',
          'flows. For lessons learned ("always probe empty state"), use',
          'memory_record instead. Returns the ticket id.',
        ].join(' '),
        {
          summary: z.string().min(1).describe('One-sentence headline'),
          description: z.string().min(1).describe('What happened, expected vs actual, repro steps'),
          severity: z.enum(['cosmetic', 'minor', 'major', 'critical']),
          area_id: z.string().optional(),
          behavior_id: z.string().optional(),
        },
        async (args) => {
          const id = await fileTicket(ctx, args);
          eventBus.send('feedback:ticket_filed', {
            id,
            specId: ctx.specId,
            runId: ctx.runId,
            severity: args.severity,
            area_id: args.area_id,
            behavior_id: args.behavior_id,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id }) }],
          };
        },
      ),
    ],
  });
}

interface TicketArgs {
  summary: string;
  description: string;
  severity: 'cosmetic' | 'minor' | 'major' | 'critical';
  area_id?: string;
  behavior_id?: string;
}

async function fileTicket(ctx: FeedbackMcpContext, args: TicketArgs): Promise<string> {
  if (ctx.sink.kind === 'bd') return fileTicketBd(ctx, args);
  return fileTicketHttp(ctx, ctx.sink, args);
}

function severityToPriority(s: TicketArgs['severity']): string {
  // bd priorities: 0 critical, 1 high, 2 medium (default), 3 low, 4 backlog.
  switch (s) {
    case 'critical': return '0';
    case 'major':    return '1';
    case 'minor':    return '2';
    case 'cosmetic': return '3';
  }
}

async function fileTicketBd(ctx: FeedbackMcpContext, args: TicketArgs): Promise<string> {
  const description = composeDescription(ctx, args);
  const cliArgs = [
    'create',
    '--title', args.summary,
    '--description', description,
    '--type', 'bug',
    '--priority', severityToPriority(args.severity),
  ];
  const exec = ctx.bdExec ?? defaultBdExec;
  const { stdout, code } = await exec(cliArgs);
  if (code !== 0) {
    throw new Error(`bd create exited ${code}: ${stdout.slice(0, 200)}`);
  }
  return parseBdId(stdout);
}

function composeDescription(ctx: FeedbackMcpContext, args: TicketArgs): string {
  const lines: string[] = [args.description, ''];
  lines.push(`Filed by specify verify (run ${ctx.runId}, spec ${ctx.specId}).`);
  if (args.area_id) lines.push(`Area: ${args.area_id}`);
  if (args.behavior_id) lines.push(`Behavior: ${args.behavior_id}`);
  return lines.join('\n');
}

function parseBdId(out: string): string {
  const m = out.match(/SP-[a-z0-9]+/i);
  if (!m) throw new Error('bd create output did not contain an SP-* issue id');
  return m[0];
}

function defaultBdExec(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bd', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout: out, code }));
  });
}

async function fileTicketHttp(ctx: FeedbackMcpContext, sink: { url: string; bearerFile?: string }, args: TicketArgs): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sink.bearerFile) {
    if (!fs.existsSync(sink.bearerFile)) {
      throw new Error(`Feedback bearer file not found: ${sink.bearerFile}`);
    }
    const token = fs.readFileSync(sink.bearerFile, 'utf-8').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(sink.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      specId: ctx.specId,
      runId: ctx.runId,
      summary: args.summary,
      description: args.description,
      severity: args.severity,
      area_id: args.area_id,
      behavior_id: args.behavior_id,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Feedback HTTP sink ${res.status}: ${detail.slice(0, 200)}`);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'unknown';
}

export const _internals = { severityToPriority, parseBdId, composeDescription };
