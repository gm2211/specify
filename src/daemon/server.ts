/**
 * src/daemon/server.ts — Long-running HTTP server for `specify daemon`.
 *
 * Exposes an inbox so other agents can push messages into a running Specify
 * process. Idle = 0 tokens (no SDK query runs until a message arrives).
 *
 * Endpoints:
 *   GET  /health                    liveness probe, no auth
 *   POST /inbox                     submit a task; returns { id, stream }
 *   GET  /inbox                     list recent messages
 *   GET  /inbox/:id                 poll message status/result
 *   GET  /inbox/:id/stream          SSE stream of agent events for :id
 *   GET  /events/stream             SSE stream of all daemon events
 *   POST /sessions/:id/close        close a persistent session
 *   GET  /sessions                  list active persistent sessions
 *
 * Auth: Bearer token via `Authorization: Bearer <token>` header. The token
 * lives in `~/.specify/daemon.token` (auto-generated on first start) or
 * `SPECIFY_INBOX_TOKEN` env var. /health is always unauthenticated.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { eventBus } from '../agent/event-bus.js';
import { inbox } from './inbox.js';
import type { InboxRequest } from './inbox.js';
import { configurePool } from './worker-pool.js';
import { renderInspectorHtml } from './inspector.js';
import { resolveSpec, specSourceFromEnv } from '../agent/spec-loader.js';
import { attachReportSinks } from '../agent/report-sink.js';

export interface DaemonOptions {
  port: number;
  host: string;
  /** Skip token auth entirely (for trusted-localhost usage). */
  noAuth?: boolean;
  /** Max concurrent stateless jobs (each in its own forked process).
   *  Default 2 — keeps memory bounded while still parallelizing verifies. */
  maxWorkers?: number;
}

const TOKEN_DIR = path.join(os.homedir(), '.specify');
const TOKEN_FILE = path.join(TOKEN_DIR, 'daemon.token');

export function resolveToken(): string {
  const env = process.env.SPECIFY_INBOX_TOKEN;
  if (env && env.trim()) return env.trim();

  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (existing) return existing;
  }

  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, fresh + '\n', { mode: 0o600 });
  return fresh;
}

export async function startDaemonServer(opts: DaemonOptions): Promise<void> {
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');

  const token = opts.noAuth ? '' : resolveToken();
  // maxWorkers=0 disables the worker pool (useful for tests that stub the
  // SDK runner via __setRunnerForTesting — they need the in-process path).
  const maxWorkers = opts.maxWorkers ?? 2;
  if (maxWorkers > 0) configurePool(maxWorkers);

  // Wire outbound report sinks (file / slack). No-op when the env vars
  // (SPECIFY_REPORT_FILE_DIR, SPECIFY_REPORT_SLACK_WEBHOOK_FILE) aren't set.
  const sinks = attachReportSinks();
  if (sinks.sinks.length > 0) {
    process.stderr.write(`[daemon] report sinks attached: ${sinks.sinks.map((s) => s.name).join(', ')}\n`);
  }

  const app = new Hono();

  // ---------------------------------------------------------------------------
  // Auth middleware — everything under /inbox, /sessions, /events requires it.
  // ---------------------------------------------------------------------------
  app.use('*', async (c, next) => {
    if (opts.noAuth) return next();
    const url = new URL(c.req.url);
    // Unauthenticated: /health (liveness) and / (inspector HTML page; it
    // authenticates via query-param token when it opens its SSE stream).
    if (url.pathname === '/health' || url.pathname === '/') return next();
    // Accept either `Authorization: Bearer <token>` or `?token=<token>`.
    // EventSource in browsers can't set custom headers, so the query form
    // is what the inspector UI uses when subscribing to SSE streams.
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const bearer = m ? m[1].trim() : '';
    const query = url.searchParams.get('token') ?? '';
    if (bearer !== token && query !== token) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  app.get('/health', (c) =>
    c.json({
      ok: true,
      uptime_s: Math.round(process.uptime()),
      sessions: inbox.sessionIds().length,
      maxWorkers,
    }),
  );

  // Landing page: live inspector for agent events, messages, sessions.
  app.get('/', (c) => {
    return c.html(renderInspectorHtml({ authRequired: !opts.noAuth }));
  });

  // Resolve the configured spec source on demand. Returns the spec hash so
  // a watcher / TF webhook can detect version changes and trigger reverify.
  // Source comes from env (SPECIFY_SPEC_INLINE_PATH | SPECIFY_SPEC_URL |
  // SPECIFY_SPEC_GIT_REPO); when none configured, returns 400.
  app.post('/control/reload-spec', async (c) => {
    let src;
    try {
      src = specSourceFromEnv();
    } catch (err) {
      return c.json({ error: 'invalid_spec_source', detail: (err as Error).message }, 400);
    }
    if (!src) return c.json({ error: 'no_spec_source_configured' }, 400);
    try {
      const r = await resolveSpec(src);
      return c.json({
        ok: true,
        hash: r.hash,
        name: r.spec.name,
        source: r.source,
      });
    } catch (err) {
      return c.json({ error: 'spec_resolve_failed', detail: (err as Error).message }, 502);
    }
  });

  app.post('/inbox', async (c) => {
    let body: Partial<InboxRequest>;
    try {
      body = await c.req.json<Partial<InboxRequest>>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const task = body.task;
    const prompt = body.prompt;
    if (!task || typeof task !== 'string') {
      return c.json({ error: 'missing_field', field: 'task' }, 400);
    }
    if (!prompt || typeof prompt !== 'string') {
      return c.json({ error: 'missing_field', field: 'prompt' }, 400);
    }
    if (!['verify', 'capture', 'compare', 'replay', 'freeform'].includes(task)) {
      return c.json({ error: 'invalid_task', task }, 400);
    }
    const message = inbox.submit(body as InboxRequest);
    return c.json({
      id: message.id,
      status: message.status,
      session: message.session,
      stream: `/inbox/${message.id}/stream`,
    }, 202);
  });

  // Convenience: POST /verify {spec, url} → shorthand for POST /inbox task=verify.
  app.post('/verify', async (c) => {
    let body: { spec?: string; url?: string; prompt?: string; mode?: 'stateless' | 'attach'; session?: string; sender?: string; outputDir?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!body.spec) return c.json({ error: 'missing_field', field: 'spec' }, 400);
    const message = inbox.submit({
      task: 'verify',
      prompt: body.prompt ?? (body.url ? `Verify ${body.url} against the spec.` : 'Verify the target against the spec.'),
      spec: body.spec,
      url: body.url,
      mode: body.mode,
      session: body.session,
      sender: body.sender,
      outputDir: body.outputDir,
    });
    return c.json({
      id: message.id,
      status: message.status,
      session: message.session,
      stream: `/inbox/${message.id}/stream`,
    }, 202);
  });

  // Convenience: POST /capture {url} → shorthand for POST /inbox task=capture.
  app.post('/capture', async (c) => {
    let body: { url?: string; spec?: string; prompt?: string; sender?: string; outputDir?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!body.url) return c.json({ error: 'missing_field', field: 'url' }, 400);
    const message = inbox.submit({
      task: 'capture',
      prompt: body.prompt ?? `Explore ${body.url} and generate a behavioral spec.`,
      url: body.url,
      spec: body.spec,
      sender: body.sender,
      outputDir: body.outputDir,
    });
    return c.json({
      id: message.id,
      status: message.status,
      stream: `/inbox/${message.id}/stream`,
    }, 202);
  });

  app.get('/inbox', (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    const items = inbox.list().slice(0, safeLimit).map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      status: m.status,
      task: m.request.task,
      session: m.session,
      error: m.error,
      costUsd: m.result?.costUsd,
    }));
    return c.json({ messages: items });
  });

  app.get('/inbox/:id', (c) => {
    const id = c.req.param('id');
    const m = inbox.get(id);
    if (!m) return c.json({ error: 'not_found', id }, 404);
    return c.json({
      id: m.id,
      createdAt: m.createdAt,
      status: m.status,
      session: m.session,
      task: m.request.task,
      result: m.result,
      error: m.error,
    });
  });

  app.get('/inbox/:id/stream', (c) => {
    const id = c.req.param('id');
    if (!inbox.get(id)) return c.json({ error: 'not_found', id }, 404);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Catch-up: recent events already tied to this message id.
        for (const event of eventBus.recent()) {
          if (event.sessionId === id) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
        }
        const unsub = eventBus.onAny((event) => {
          if (event.sessionId !== id) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            unsub();
          }
          if (event.type === 'inbox:completed' || event.type === 'inbox:failed') {
            try { controller.close(); } catch { /* already closed */ }
            unsub();
          }
        });
        c.req.raw.signal.addEventListener('abort', () => unsub());
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  app.get('/events/stream', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of eventBus.recent(20)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        const unsub = eventBus.onAny((event) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            unsub();
          }
        });
        c.req.raw.signal.addEventListener('abort', () => unsub());
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  app.get('/sessions', (c) => c.json({ sessions: inbox.sessionIds() }));

  app.post('/sessions/:id/close', (c) => {
    const id = c.req.param('id');
    const ok = inbox.closeSession(id);
    return c.json({ closed: ok, id }, ok ? 200 : 404);
  });

  // ---------------------------------------------------------------------------
  // Bind
  // ---------------------------------------------------------------------------

  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host });

  const bindDesc = `http://${opts.host}:${opts.port}`;
  process.stderr.write(`\n  Specify daemon listening on ${bindDesc}\n`);
  if (!opts.noAuth) {
    process.stderr.write(`  Auth: Bearer <token from ${TOKEN_FILE} or $SPECIFY_INBOX_TOKEN>\n`);
  } else {
    process.stderr.write(`  Auth: disabled (--no-auth)\n`);
  }
  process.stderr.write(`  Health: GET /health   Inbox: POST /inbox\n`);
  process.stderr.write(`\n  Press Ctrl+C to stop.\n\n`);

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      try { (server as unknown as { close?: () => void }).close?.(); } catch { /* best effort */ }
      resolve();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
