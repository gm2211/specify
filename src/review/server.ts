/**
 * src/review/server.ts — Hono HTTP server for the Specify review webapp
 *
 * Serves the built React app from dist/webapp/ and provides API endpoints
 * for reading/writing spec files, verification results, and narratives.
 * WebSocket support for live updates when files change on disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { eventBus } from '../agent/event-bus.js';
import type { MessageInjector } from '../agent/message-injector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Module-level reference to the active message injector (if any). */
let activeInjector: MessageInjector | null = null;

export function setActiveInjector(injector: MessageInjector | null): void {
  activeInjector = injector;
}

/** Guard so we don't run two verify agents at once from the server. */
let verifyInFlight = false;

async function runVerifyInBackground(
  specPath: string,
  resultsDir: string,
  scope?: { areaId: string; behaviorId: string },
): Promise<void> {
  if (verifyInFlight) {
    process.stderr.write('Verify already running — ignoring new request.\n');
    return;
  }
  verifyInFlight = true;
  try {
    eventBus.send('verify:started', { scope: scope ?? null });
    const { loadSpec, specToYaml } = await import('../spec/parser.js');
    const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
    const { getVerifyPrompt } = await import('../agent/prompts.js');

    const spec = loadSpec(specPath);

    // Scope: narrow the spec to a single behavior if requested.
    const scopedSpec = scope
      ? (() => {
          const area = spec.areas.find((a) => a.id === scope.areaId);
          const behavior = area?.behaviors.find((b) => b.id === scope.behaviorId);
          if (!area || !behavior) {
            throw new Error(`Behavior ${scope.areaId}/${scope.behaviorId} not found in spec`);
          }
          return { ...spec, areas: [{ ...area, behaviors: [behavior] }] };
        })()
      : spec;

    const prompt = getVerifyPrompt(specToYaml(scopedSpec));
    const targetUrl =
      spec.target.type === 'web' || spec.target.type === 'api'
        ? (spec.target as { url: string }).url
        : undefined;

    const { structuredOutput } = await runSpecifyAgent({
      task: 'verify',
      systemPrompt: prompt,
      userPrompt: scope
        ? `Verify only behavior "${scope.areaId}/${scope.behaviorId}" against the spec.`
        : `Verify the target against the behavioral spec.`,
      ...(targetUrl ? { url: targetUrl } : {}),
      spec: specPath,
      outputDir: resultsDir,
    });

    // Merge: scoped runs update just the targeted behavior in the existing report.
    const reportPath = path.join(resultsDir, 'verify-result.json');
    const existing = fs.existsSync(reportPath)
      ? (() => {
          try {
            const raw = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
            return raw && typeof raw === 'object' && 'structuredOutput' in raw
              ? (raw as { structuredOutput: unknown }).structuredOutput
              : raw;
          } catch {
            return null;
          }
        })()
      : null;

    const merged =
      scope && existing && typeof existing === 'object' && 'results' in existing
        ? mergeScopedResult(existing as Record<string, unknown>, structuredOutput, scope)
        : structuredOutput;

    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ structuredOutput: merged }, null, 2), 'utf-8');
    eventBus.send('verify:completed', { scope: scope ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Strip ANSI escape sequences that Playwright (and others) emit in error
    // messages — they look like garbage in HTML.
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    eventBus.send('verify:failed', { scope: scope ?? null, error: clean });
    throw err;
  } finally {
    verifyInFlight = false;
  }
}

/**
 * Merge a scoped (single-behavior) verify result into an existing full report.
 * Replaces the matching result and recomputes the summary.
 */
function mergeScopedResult(
  existing: Record<string, unknown>,
  fresh: unknown,
  scope: { areaId: string; behaviorId: string },
): Record<string, unknown> {
  const freshResults = Array.isArray((fresh as { results?: unknown })?.results)
    ? ((fresh as { results: Array<Record<string, unknown>> }).results)
    : [];
  const targetId = `${scope.areaId}/${scope.behaviorId}`;
  const incoming = freshResults.find((r) => r.id === targetId);
  if (!incoming) return existing;

  const prevResults = Array.isArray(existing.results)
    ? (existing.results as Array<Record<string, unknown>>)
    : [];
  const nextResults = prevResults.some((r) => r.id === targetId)
    ? prevResults.map((r) => (r.id === targetId ? incoming : r))
    : [...prevResults, incoming];

  const passed = nextResults.filter((r) => r.status === 'passed').length;
  const failed = nextResults.filter((r) => r.status === 'failed').length;
  const skipped = nextResults.filter((r) => r.status === 'skipped').length;

  return {
    ...existing,
    results: nextResults,
    summary: { total: nextResults.length, passed, failed, skipped },
    pass: failed === 0 && nextResults.length > 0,
  };
}

export interface ServeOptions {
  specPath: string;
  port: number;
  open: boolean;
  agentReport?: string;
}

export async function startReviewServer(options: ServeOptions): Promise<void> {
  const { specPath, port, open: shouldOpen, agentReport } = options;
  const resolvedSpec = path.resolve(specPath);
  const specDir = path.dirname(resolvedSpec);
  const resultsPath = path.join(specDir, '.specify', 'verify', 'verify-result.json');
  const resultsDir = path.join(specDir, '.specify', 'verify');

  // Dynamic imports for heavy deps
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { WebSocketServer } = await import('ws');

  // Resolve webapp dist directory — walk up from this file to project root
  let projectRoot = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(projectRoot, 'package.json'))) break;
    projectRoot = path.dirname(projectRoot);
  }
  const webappDist = path.join(projectRoot, 'dist', 'webapp');

  const app = new Hono();

  // -------------------------------------------------------------------------
  // API endpoints
  // -------------------------------------------------------------------------

  app.get('/api/spec', async (c) => {
    try {
      const { loadSpec } = await import('../spec/parser.js');
      const spec = loadSpec(resolvedSpec);
      return c.json(spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'load_failed', message: msg }, 500);
    }
  });

  app.get('/api/results', async (c) => {
    // If an agent report was provided via CLI, prefer that
    const reportPath = agentReport ? path.resolve(agentReport) : resultsPath;
    try {
      if (!fs.existsSync(reportPath)) {
        return c.json({});
      }
      const raw = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      // CLI writes { structuredOutput: {...} }; unwrap for the webapp.
      const data = raw && typeof raw === 'object' && 'structuredOutput' in raw
        ? (raw as { structuredOutput: unknown }).structuredOutput
        : raw;
      return c.json(data ?? {});
    } catch {
      return c.json({});
    }
  });

  // Serve screenshot files captured during verify runs. The agent stores
  // absolute paths in action_trace; the client passes the basename and we
  // look it up under the known screenshots directory.
  const screenshotsDir = path.join(resultsDir, 'capture', 'screenshots');
  app.get('/api/screenshot/:name', async (c) => {
    const name = c.req.param('name');
    // Security: only allow plain filenames, no traversal.
    if (!/^[a-zA-Z0-9._-]+\.png$/.test(name)) {
      return c.text('Bad request', 400);
    }
    const filePath = path.join(screenshotsDir, name);
    if (!filePath.startsWith(screenshotsDir) || !fs.existsSync(filePath)) {
      return c.text('Not found', 404);
    }
    const content = fs.readFileSync(filePath);
    return new Response(content, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
    });
  });

  app.get('/api/narrative', async (c) => {
    // Auto-discover narrative file next to spec
    const baseName = path.basename(resolvedSpec).replace(/\.(ya?ml|json)$/, '.narrative.md');
    const narrativePath = path.resolve(specDir, baseName);
    try {
      if (!fs.existsSync(narrativePath)) {
        return c.json({ content: '' });
      }
      const content = fs.readFileSync(narrativePath, 'utf-8');
      return c.json({ content });
    } catch {
      return c.json({ content: '' });
    }
  });

  app.put('/api/spec', async (c) => {
    try {
      const body = await c.req.json<{ yaml: string }>();
      if (!body.yaml || typeof body.yaml !== 'string') {
        return c.json({ error: 'invalid_body', message: 'Expected { yaml: string }' }, 400);
      }
      // Validate before writing
      const { parseSpec } = await import('../spec/parser.js');
      parseSpec(body.yaml, resolvedSpec);
      // Write to disk
      fs.writeFileSync(resolvedSpec, body.yaml, 'utf-8');
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'write_failed', message: msg }, 400);
    }
  });

  app.get('/api/verify/status', async (c) => {
    return c.json({ inFlight: verifyInFlight });
  });

  app.post('/api/verify', async (c) => {
    if (verifyInFlight) return c.json({ error: 'busy' }, 409);
    runVerifyInBackground(resolvedSpec, resultsDir).catch((err) => {
      process.stderr.write(`Verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return c.json({ started: true });
  });

  app.post('/api/verify/:areaId/:behaviorId', async (c) => {
    if (verifyInFlight) return c.json({ error: 'busy' }, 409);
    const { areaId, behaviorId } = c.req.param();
    runVerifyInBackground(resolvedSpec, resultsDir, { areaId, behaviorId }).catch((err) => {
      process.stderr.write(`Scoped verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return c.json({ started: true, areaId, behaviorId });
  });

  // -------------------------------------------------------------------------
  // Event stream (SSE) — inter-agent event channel
  // -------------------------------------------------------------------------

  app.get('/api/events/stream', async (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Send recent events for catch-up
        for (const event of eventBus.recent(20)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        // Subscribe to new events
        const unsub = eventBus.onAny((event) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            unsub();
          }
        });
        // Clean up on close (handled by AbortSignal)
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

  // Publish an event from an external agent
  app.post('/api/events/publish', async (c) => {
    try {
      const body = await c.req.json<{ type: string; data?: Record<string, unknown> }>();
      if (!body.type) return c.json({ error: 'missing type' }, 400);
      eventBus.send(body.type, body.data ?? {});
      return c.json({ published: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Cooperative-QA feedback: webapp sends per-event flags + free-text notes;
  // we route by kind into an Observation (per-spec layer) and optionally a
  // bd issue. See src/agent/feedback.ts for kind semantics.
  app.post('/api/feedback', async (c) => {
    try {
      const body = await c.req.json<{
        kind: string;
        text: string;
        sessionId?: string;
        areaId?: string;
        behaviorId?: string;
        eventId?: string;
      }>();
      if (!body.kind || !body.text) {
        return c.json({ error: 'invalid_body', message: 'Expected { kind, text, ... }' }, 400);
      }
      const allowed = new Set(['note', 'important_pattern', 'missed_check', 'false_positive', 'ignore_pattern', 'file_bug']);
      if (!allowed.has(body.kind)) {
        return c.json({ error: 'invalid_kind', message: `kind must be one of: ${Array.from(allowed).join(', ')}` }, 400);
      }
      const { ingestFeedback } = await import('../agent/feedback.js');
      const result = await ingestFeedback(
        {
          kind: body.kind as 'note',
          text: body.text,
          sessionId: body.sessionId,
          areaId: body.areaId,
          behaviorId: body.behaviorId,
          eventId: body.eventId,
        },
        { specPath: resolvedSpec },
      );
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'feedback_failed', message: msg }, 400);
    }
  });

  // Inject a message into the running agent session
  app.post('/api/agent/inject', async (c) => {
    if (!activeInjector) {
      return c.json({ error: 'no_active_session' }, 404);
    }
    try {
      const body = await c.req.json<{ message: string; priority?: 'now' | 'next' | 'later' }>();
      if (!body.message) return c.json({ error: 'missing message' }, 400);
      activeInjector.inject(body.message, body.priority ?? 'next');
      return c.json({ injected: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // -------------------------------------------------------------------------
  // Static file serving (built React app)
  // -------------------------------------------------------------------------

  app.get('/*', async (c) => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const filePath = path.join(webappDist, reqPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(webappDist)) {
      return c.text('Forbidden', 403);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      };
      const contentType = mimeTypes[ext] ?? 'application/octet-stream';
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    }

    // SPA fallback — serve index.html for unmatched routes
    const indexPath = path.join(webappDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      return c.html(content);
    }

    return c.text('Not found', 404);
  });

  // -------------------------------------------------------------------------
  // Start HTTP server
  // -------------------------------------------------------------------------

  const server = serve({
    fetch: app.fetch,
    port,
  });

  // -------------------------------------------------------------------------
  // WebSocket server for live updates
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ server: server as any });

  function broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(data);
      }
    }
  }

  // Forward agent events over WebSocket
  const unsubEvents = eventBus.onAny((event) => {
    broadcast({ type: 'agent:event', event });
  });

  // -------------------------------------------------------------------------
  // File watching
  // -------------------------------------------------------------------------

  const watchers: fs.FSWatcher[] = [];

  // Watch spec file
  try {
    const specWatcher = fs.watch(resolvedSpec, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        broadcast({ type: 'spec:updated' });
      }
    });
    watchers.push(specWatcher);
  } catch {
    process.stderr.write(`Warning: could not watch spec file: ${resolvedSpec}\n`);
  }

  // Watch results directory
  if (fs.existsSync(resultsDir)) {
    try {
      const resultsWatcher = fs.watch(resultsDir, { persistent: false }, (eventType, filename) => {
        if (filename && filename.endsWith('.json')) {
          broadcast({ type: 'results:updated' });
        }
      });
      watchers.push(resultsWatcher);
    } catch {
      process.stderr.write(`Warning: could not watch results directory: ${resultsDir}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Startup info
  // -------------------------------------------------------------------------

  const url = `http://localhost:${port}`;
  process.stderr.write(`\n  Specify Review Server\n`);
  process.stderr.write(`  Spec:    ${resolvedSpec}\n`);
  process.stderr.write(`  Server:  ${url}\n`);
  if (agentReport) {
    process.stderr.write(`  Report:  ${path.resolve(agentReport)}\n`);
  }
  process.stderr.write(`\n  Press Ctrl+C to stop.\n\n`);

  // Auto-open in browser
  if (shouldOpen) {
    const { execFile } = await import('child_process');
    const platform = process.platform;
    const openCmd = platform === 'darwin' ? 'open'
      : platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const openArgs = platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url];
    execFile(openCmd, openArgs, (err) => {
      if (err) {
        process.stderr.write(`Could not auto-open browser: ${err.message}\n`);
        process.stderr.write(`Open manually: ${url}\n`);
      }
    });
  }

  // Keep the process alive — wait for SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      unsubEvents();
      for (const w of watchers) w.close();
      wss.close();
      resolve();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
