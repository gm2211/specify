/**
 * src/agent/sdk-runner.ts — Core runner for Agent SDK integration
 *
 * Launches Playwright + CaptureCollector for web targets, then drives
 * Claude via the Agent SDK query() function with browser MCP tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, JsonSchemaOutputFormat, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { eventBus } from './event-bus.js';
import type { MessageInjector } from './message-injector.js';
import { defaultMemoryProvider, type MemoryScope } from './memory-provider.js';
import { createMemoryMcpServer } from './memory-mcp.js';
import { defaultSessionDbPath, openSessionStore, type SessionStore } from './session-store.js';
import { loadLayeredContext, renderLayeredPrompt } from './memory-layers.js';
import { setActivePropagator } from './pattern-propagator.js';
import { ConfidenceStore, defaultConfidencePath } from './confidence-store.js';
import { randomUUID } from 'node:crypto';

export interface BehaviorProgress {
  id: string;
  description?: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  rationale?: string;
}

export interface SdkRunnerOptions {
  task: 'capture' | 'verify' | 'replay' | 'compare' | 'augment';
  systemPrompt: string;
  userPrompt: string;
  url?: string;
  remoteUrl?: string;
  localUrl?: string;
  spec?: string;
  captureDir?: string;
  outputDir: string;
  cwd?: string;
  specOutput?: string;
  specName?: string;
  headed?: boolean;
  /** Enable verbose/debug output to stderr. */
  debug?: boolean;
  /** Max retry attempts for transient API errors (default: 3). */
  maxRetries?: number;
  /** Callback fired when a behavior result is detected during verify. */
  onBehaviorProgress?: (progress: BehaviorProgress) => void;
  /** Message injector for interleaved human/agent input. */
  messageInjector?: MessageInjector;
  /** Custom ask_user handler (for chat mode / WebSocket). */
  askUserHandler?: (question: string) => Promise<string>;
}

export interface SdkRunnerResult {
  result: string;
  costUsd: number;
  structuredOutput?: unknown;
  sessionId?: string;
}

/** Error thrown when the Agent SDK returns a non-success result. */
export class AgentError extends Error {
  constructor(
    public readonly subtype: string,
    public readonly costUsd: number,
    public readonly cause?: unknown,
  ) {
    super(`Agent ended with ${subtype}`);
    this.name = 'AgentError';
  }
}

/** Type-safe extraction of a boolean field from structured output. */
export function extractBool(output: unknown, field: string): boolean | null {
  if (output && typeof output === 'object' && field in output) {
    const val = (output as Record<string, unknown>)[field];
    return typeof val === 'boolean' ? val : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error classification for retry logic
// ---------------------------------------------------------------------------

type ErrorClass = 'transient' | 'auth' | 'fatal';

function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Transient network/connection errors
  const transientPatterns = [
    'ebadf', 'econnreset', 'econnrefused', 'etimedout', 'epipe',
    'socket hang up', 'network error', 'fetch failed',
    'overloaded', '529', '500', '502', '503', '504', '429',
  ];
  if (transientPatterns.some(p => lower.includes(p))) return 'transient';

  // Auth errors
  if (lower.includes('401') || lower.includes('authentication') || lower.includes('unauthorized')) {
    return 'auth';
  }

  return 'fatal';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Browser session management
// ---------------------------------------------------------------------------

interface BrowserSession {
  browser: import('playwright').Browser;
  collector: import('./capture.js').CaptureCollector;
  page: import('playwright').Page;
  mcpServer: McpServerConfig;
}

async function launchBrowserSession(
  url: string,
  captureOutputDir: string,
  headed: boolean,
  serverName: string,
  askUserHandler?: (question: string) => Promise<string>,
): Promise<BrowserSession> {
  const { chromium } = await import('playwright');
  const { CaptureCollector } = await import('./capture.js');
  const { createBrowserMcpServer } = await import('./browser-mcp.js');

  const parsedUrl = new URL(url);
  const contextOptions: Record<string, unknown> = {
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  };
  let navigateUrl = url;
  if (parsedUrl.username) {
    contextOptions.httpCredentials = {
      username: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
    };
    parsedUrl.username = '';
    parsedUrl.password = '';
    navigateUrl = parsedUrl.toString();
  }

  const collector = new CaptureCollector({
    outputDir: captureOutputDir,
    targetUrl: url,
    hostFilter: new URL(url).hostname,
  });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext(contextOptions as Parameters<typeof browser.newContext>[0]);
  await collector.attachToContext(context);
  const page = await context.newPage();
  collector.attachToPage(page);

  await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await collector.screenshot(page, 'initial');

  const mcpServer = createBrowserMcpServer(
    page,
    (name: string) => collector.screenshot(page, name),
    serverName,
    askUserHandler,
  );

  return { browser, collector, page, mcpServer };
}

function browserToolNames(serverName: string): string[] {
  return [
    `mcp__${serverName}__browser_goto`, `mcp__${serverName}__browser_click`,
    `mcp__${serverName}__browser_fill`, `mcp__${serverName}__browser_type`,
    `mcp__${serverName}__browser_select`, `mcp__${serverName}__browser_hover`,
    `mcp__${serverName}__browser_press`, `mcp__${serverName}__browser_screenshot`,
    `mcp__${serverName}__browser_content`, `mcp__${serverName}__browser_evaluate`,
    `mcp__${serverName}__browser_url`, `mcp__${serverName}__browser_title`,
    `mcp__${serverName}__browser_wait_for`, `mcp__${serverName}__ask_user`,
  ];
}

function getOutputFormat(task: string): JsonSchemaOutputFormat | undefined {
  if (task === 'verify') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean', description: 'True only if ALL behaviors pass' },
          summary: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              passed: { type: 'number' },
              failed: { type: 'number' },
              skipped: { type: 'number' },
            },
            required: ['total', 'passed', 'failed', 'skipped'],
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Fully-qualified: area-id/behavior-id' },
                description: { type: 'string' },
                status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
                method: { type: 'string', description: 'How the behavior was verified' },
                evidence: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['screenshot', 'text', 'network_log', 'command_output', 'file'] },
                      label: { type: 'string' },
                      content: { type: 'string' },
                    },
                    required: ['type', 'label', 'content'],
                  },
                },
                action_trace: {
                  type: 'array',
                  description: 'Ordered, human-readable log of the steps the agent performed to verify this behavior. Each entry describes one action (navigate, click, observe, assert, ...) and may reference a screenshot file captured during that step.',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['navigation', 'click', 'fill', 'screenshot', 'observation', 'assertion', 'wait', 'other'] },
                      description: { type: 'string', description: 'One-sentence plain-language description of the step' },
                      screenshot: { type: 'string', description: 'Absolute path to a screenshot captured at this step, if any' },
                      timestamp: { type: 'string', description: 'ISO timestamp, optional' },
                    },
                    required: ['type', 'description'],
                  },
                },
                rationale: { type: 'string' },
                duration_ms: { type: 'number' },
              },
              required: ['id', 'description', 'status'],
            },
          },
          test_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Paths to generated Playwright test files',
          },
        },
        required: ['pass', 'summary', 'results', 'test_files'],
      },
    };
  }
  if (task === 'compare') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          match: { type: 'boolean', description: 'True only if no meaningful differences found' },
          summary: { type: 'string', description: 'One-line summary' },
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'string', description: 'Page path or identifier' },
                description: { type: 'string', description: 'What differs' },
                remote: { type: 'string', description: 'Remote behavior' },
                local: { type: 'string', description: 'Local behavior' },
                severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic'] },
              },
              required: ['page', 'description', 'remote', 'local', 'severity'],
            },
          },
        },
        required: ['match', 'summary', 'diffs'],
      },
    };
  }
  if (task === 'augment') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          synthetic_traffic: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                method: { type: 'string' },
                status: { type: 'number' },
                contentType: { type: 'string' },
                responseBody: { type: 'string' },
              },
              required: ['url', 'method', 'status', 'contentType', 'responseBody'],
            },
          },
        },
        required: ['synthetic_traffic'],
      },
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Core agent execution with retry
// ---------------------------------------------------------------------------

interface QueryResult {
  result: string;
  costUsd: number;
  structuredOutput?: unknown;
  sessionId?: string;
}

async function executeQuery(
  queryOptions: Options,
  prompt: string | AsyncIterable<SDKUserMessage>,
  opts: SdkRunnerOptions,
): Promise<QueryResult> {
  let finalResult = '';
  let costUsd = 0;
  let structuredOutput: unknown | undefined;
  let sessionId: string | undefined;
  let receivedFirstMessage = false;

  const q = query({ prompt, options: queryOptions });

  // Timeout for initial connection — if no message arrives in 30s, bail
  const INIT_TIMEOUT_MS = 30_000;
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  const initTimeout = new Promise<never>((_, reject) => {
    initTimer = setTimeout(() => {
      if (!receivedFirstMessage) {
        reject(new Error(
          'Timed out waiting for API connection (30s). ' +
          'This usually means authentication failed. ' +
          'Check your ANTHROPIC_API_KEY and try again.',
        ));
      }
    }, INIT_TIMEOUT_MS);
  });

  try {
    // Race: either we get messages or we time out
    const iterator = q[Symbol.asyncIterator]();
    while (true) {
      const nextPromise = iterator.next();
      const result = receivedFirstMessage
        ? await nextPromise
        : await Promise.race([nextPromise, initTimeout]);

      if (result.done) break;
      const message = result.value;

      if (!receivedFirstMessage) {
        receivedFirstMessage = true;
        if (initTimer) clearTimeout(initTimer);
        process.stderr.write('  Agent connected.\n');
      }

      if (message.type === 'auth_status') {
        const authMsg = message as { isAuthenticating: boolean; output: string[]; error?: string };
        if (authMsg.error) {
          throw new Error(`Authentication failed: ${authMsg.error}`);
        }
        if (authMsg.isAuthenticating) {
          process.stderr.write('  Authenticating...\n');
        }
        for (const line of authMsg.output) {
          if (opts.debug) process.stderr.write(`  ${line}\n`);
        }
        continue;
      }

      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init' && 'session_id' in message) {
        sessionId = message.session_id as string;
        eventBus.send('agent:started', { task: opts.task }, sessionId);
      } else if (message.type === 'assistant') {
        const textBlocks = message.message.content.filter((b: { type: string }) => b.type === 'text');
        for (const block of textBlocks) {
          const text = (block as { type: 'text'; text: string }).text;
          if (opts.debug) {
            process.stderr.write(text + '\n');
          }
          eventBus.send('agent:text', { text }, sessionId);
        }
        if (opts.debug) process.stderr.write('\n');
      } else if (message.type === 'tool_use_summary' && 'summary' in message) {
        const summary = (message as { summary: string }).summary;
        if (opts.debug) {
          process.stderr.write(`  \x1b[2m${summary}\x1b[0m\n`);
        }
        eventBus.send('agent:tool_use', { summary }, sessionId);
      } else if (message.type === 'result') {
      if (message.subtype === 'success') {
        finalResult = message.result;
        costUsd = message.total_cost_usd;
        structuredOutput = message.structured_output;
        eventBus.send('agent:completed', {
          task: opts.task,
          costUsd,
          pass: extractBool(structuredOutput, 'pass'),
        }, sessionId);

        // Emit per-behavior progress from structured output
        if (structuredOutput && typeof structuredOutput === 'object' && 'results' in structuredOutput) {
          const results = (structuredOutput as { results: Array<{ id: string; description?: string; status: string; duration_ms?: number; rationale?: string }> }).results;
          if (Array.isArray(results)) {
            for (const r of results) {
              const status = r.status as BehaviorProgress['status'];
              const progress: BehaviorProgress = {
                id: r.id,
                description: r.description,
                status,
                duration_ms: r.duration_ms,
                rationale: r.rationale,
              };
              eventBus.send(`behavior:${status}`, { ...progress }, sessionId);
              opts.onBehaviorProgress?.(progress);
            }
          }
        }
      } else {
        costUsd = message.total_cost_usd;
        eventBus.send('agent:error', { subtype: message.subtype, costUsd }, sessionId);
        throw new AgentError(message.subtype, costUsd);
      }
    }
    }
  } finally {
    if (initTimer) clearTimeout(initTimer);
  }

  return { result: finalResult, costUsd, structuredOutput, sessionId };
}

export async function runSpecifyAgent(opts: SdkRunnerOptions): Promise<SdkRunnerResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  const sessions: BrowserSession[] = [];
  const mcpServers: Record<string, McpServerConfig> = {};
  const allowedBrowserTools: string[] = [];

  // Session indexer: persist every event from this run into a SQLite + FTS5
  // store for cross-session recall. Spec-scoped DB by default.
  let sessionStore: SessionStore | undefined;
  let detachStore: (() => void) | undefined;
  try {
    sessionStore = openSessionStore(defaultSessionDbPath(opts.spec));
    detachStore = sessionStore.attachToEventBus({
      defaults: {
        task: opts.task,
        startedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Indexer is best-effort; never break the run.
    process.stderr.write(`  Session indexer unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Confidence store: tally per-behavior accept/override stats from feedback
  // events. Only meaningful when we have a spec to scope the file to.
  let confidenceStore: ConfidenceStore | undefined;
  if (opts.spec) {
    try {
      confidenceStore = new ConfidenceStore(defaultConfidencePath(opts.spec));
      confidenceStore.attachToEventBus();
    } catch (err) {
      process.stderr.write(`  Confidence store unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  try {
    if (opts.task === 'compare') {
      // Dual browser sessions for compare
      if (!opts.remoteUrl || !opts.localUrl) {
        throw new Error('compare task requires both remoteUrl and localUrl');
      }
      process.stderr.write('  Launching browsers...\n');
      const remoteSession = await launchBrowserSession(opts.remoteUrl, path.join(opts.outputDir, 'remote'), !!opts.headed, 'remote', opts.askUserHandler);
      sessions.push(remoteSession);
      const localSession = await launchBrowserSession(opts.localUrl, path.join(opts.outputDir, 'local'), !!opts.headed, 'local', opts.askUserHandler);
      sessions.push(localSession);
      mcpServers.remote = remoteSession.mcpServer;
      mcpServers.local = localSession.mcpServer;
      allowedBrowserTools.push(...browserToolNames('remote'), ...browserToolNames('local'));
    } else if (opts.url) {
      // Single browser session for capture/verify/replay
      process.stderr.write('  Launching browser...\n');
      const session = await launchBrowserSession(
        opts.url,
        path.join(opts.outputDir, 'capture'),
        !!opts.headed,
        'browser',
        opts.askUserHandler,
      );
      sessions.push(session);
      mcpServers.browser = session.mcpServer;
      allowedBrowserTools.push(...browserToolNames('browser'));
      process.stderr.write('  Browser ready.\n');
    }

    // Sandbox: web-target sessions only get the tools they need.
    const fileTools: string[] = ['Read'];
    if (opts.task === 'capture' || opts.task === 'compare' || opts.task === 'verify') {
      fileTools.push('Write');
    }

    // Learned memory: only verify tasks participate. Read the store and
    // prepend the summary to the system prompt so the agent starts with
    // prior knowledge; expose memory_record + memory_list tools so the
    // agent can write back durable lessons.
    let systemPrompt = opts.systemPrompt;
    const memoryTools: string[] = [];

    // Layered context (user / project / per-spec observations) is loaded for
    // every task — not just verify — since project-level guidance and user
    // preferences apply to capture/replay/compare too.
    if (opts.spec) {
      try {
        const layered = renderLayeredPrompt(loadLayeredContext(opts.spec));
        if (layered) systemPrompt = layered + '\n\n' + systemPrompt;
      } catch (err) {
        process.stderr.write(`  Layered context unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Learned memory: only verify tasks participate. Read the store and
    // prepend the summary to the system prompt so the agent starts with
    // prior knowledge; expose memory_record + memory_list tools so the
    // agent can write back durable lessons.
    if (opts.task === 'verify' && opts.spec) {
      try {
        const { loadSpec } = await import('../spec/parser.js');
        const spec = loadSpec(opts.spec);
        const target = {
          type: spec.target.type as 'web' | 'api' | 'cli',
          url: (spec.target as { url?: string }).url,
          binary: (spec.target as { binary?: string }).binary,
        };
        const provider = defaultMemoryProvider();
        const scope: MemoryScope = { specPath: opts.spec, specId: spec.name, target };
        const memoryIntro = await provider.prefetch(scope);
        if (memoryIntro) {
          systemPrompt = memoryIntro + '\n\n' + systemPrompt;
        }
        const memoryServer = createMemoryMcpServer({
          scope,
          runId: `run_${randomUUID().slice(0, 8)}`,
          provider,
        });
        mcpServers.memory = memoryServer;
        memoryTools.push('mcp__memory__memory_record', 'mcp__memory__memory_list');
      } catch (err) {
        // Non-fatal: memory is a learning aid, not a correctness requirement.
        process.stderr.write(`  Memory store unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    const outputFormat = getOutputFormat(opts.task);

    const queryOptions: Options = {
      model: 'claude-opus-4-6',
      systemPrompt,
      thinking: { type: 'adaptive' },
      mcpServers,
      allowedTools: [
        ...fileTools,
        ...allowedBrowserTools,
        ...memoryTools,
      ],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: opts.cwd ?? process.cwd(),
      maxTurns: 200,
      maxBudgetUsd: 5,
      persistSession: false,
      ...(outputFormat ? { outputFormat } : {}),
    };

    // Use message injector if provided, otherwise plain string prompt
    const prompt: string | AsyncIterable<SDKUserMessage> =
      opts.messageInjector ?? opts.userPrompt;

    // Wire the in-session sibling-check propagator to the injector for the
    // lifetime of this run. When user feedback fires
    // feedback:propagate_pattern, the propagator injects a follow-up
    // directive into the active session.
    if (opts.messageInjector) {
      setActivePropagator(opts.messageInjector);
    }

    process.stderr.write('  Connecting to API...\n');

    // Retry loop for transient errors
    const maxRetries = opts.maxRetries ?? 3;
    let lastError: unknown;
    let totalCostUsd = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          const delayMs = 1000 * Math.pow(2, attempt - 1); // 2s, 4s
          process.stderr.write(`  Retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})...\n`);
          eventBus.send('agent:retry', { attempt, maxRetries, delayMs });
          await sleep(delayMs);
        }

        const result = await executeQuery(queryOptions, prompt, opts);
        result.costUsd += totalCostUsd;
        return result;
      } catch (err) {
        lastError = err;
        const errClass = classifyError(err);

        if (err instanceof AgentError) {
          totalCostUsd += err.costUsd;
        }

        if (errClass === 'fatal' || attempt === maxRetries) {
          // Fatal error or exhausted retries — propagate
          const msg = err instanceof Error ? err.message : String(err);
          eventBus.send('agent:failed', { error: msg, errorClass: errClass, attempt });
          if (err instanceof AgentError) {
            throw new AgentError(err.subtype, totalCostUsd, err);
          }
          throw err;
        }

        if (errClass === 'auth') {
          process.stderr.write(`  Auth error — check ANTHROPIC_API_KEY and retry.\n`);
          eventBus.send('agent:auth_error', { attempt });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`  Transient error: ${msg}\n`);
        }
      }
    }

    // Should not reach here, but just in case
    throw lastError;
  } finally {
    for (const session of sessions) {
      session.collector.save();
      await session.browser.close().catch(() => {});
    }
    if (detachStore) detachStore();
    if (sessionStore) {
      try { sessionStore.close(); } catch { /* noop */ }
    }
    if (confidenceStore) {
      try { confidenceStore.close(); } catch { /* noop */ }
    }
    setActivePropagator(null);
  }
}
