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
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      return c.json(data);
    } catch {
      return c.json({});
    }
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

  app.post('/api/verify', async (c) => {
    // Placeholder — full verification not yet wired
    return c.json({ started: true });
  });

  app.post('/api/verify/:areaId/:behaviorId', async (c) => {
    // Placeholder — single behavior verification not yet wired
    const { areaId, behaviorId } = c.req.param();
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
