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
import { defaultMemoryProvider, type MemoryProvider, type MemoryScope } from './memory-provider.js';
import { honchoFromEnv } from './honcho-provider.js';
import { createMemoryMcpServer } from './memory-mcp.js';
import { createFeedbackMcpServer, feedbackSinkFromEnv } from './feedback-mcp.js';
import { createDecisionsMcpServer } from './decisions-mcp.js';
import { defaultSessionDbPath, openSessionStore, type SessionStore } from './session-store.js';
import { loadLayeredContext, renderLayeredPrompt } from './memory-layers.js';
import { setActivePropagator } from './pattern-propagator.js';
import { ConfidenceStore, defaultConfidencePath } from './confidence-store.js';
import { renderActiveSkillsPrompt } from './skill-synthesizer.js';
import { learnedSkillsEnabled } from './feature-flags.js';
import { formulaSchema } from '../monitor/formula.js';
import { randomUUID, createHash } from 'node:crypto';

/**
 * Numeric override from the environment for per-run agent caps
 * (SPECIFY_MAX_BUDGET_USD, SPECIFY_MAX_TURNS) so deployments like the
 * in-cluster QA pod can raise them without an image rebuild. Invalid or
 * non-positive values fall back to the default.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BehaviorProgress {
  id: string;
  description?: string;
  status: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  rationale?: string;
}

export interface SdkRunnerOptions {
  task: 'capture' | 'verify' | 'replay' | 'compare' | 'compile';
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
  /**
   * Recorded prompt-context bundle (from a prior run's run-context.json) to
   * replay verbatim instead of fetching live memory/layered-context/skills
   * text. Used by `specify verify --with-context <path>` for "as-of-that-run"
   * re-verification. An unset field falls back to live injection for that
   * part; an explicit empty string means "nothing was injected that run".
   */
  contextOverride?: {
    memoryPreamble?: string;
    layeredContext?: string;
    skillsText?: string;
  };
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
// Per-run repro bundle (run-context.json) — SP-bhm
//
// A verdict is a function of (spec, target, model, limits, AND the learning
// state injected into the prompt: memory preamble, layered context, active
// skills). Only outputs were persisted before this; when a verdict flips
// between runs there was no way to tell whether the target changed or the
// learning loop changed the prompt. This bundle records exactly what was
// injected so a later `--with-context` run can reproduce it byte-identically.
// ---------------------------------------------------------------------------

/** Strip userinfo (username/password) from a URL. Never persist credentials. */
export function redactUrlUserinfo(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    // Not a parseable URL (e.g. a CLI binary path) — nothing to redact.
    return rawUrl;
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Compose the final system prompt from the base prompt plus the optional
 * injected preamble texts, in the same prepend order the runner has always
 * used: memory preamble innermost-first, then skills, then layered context,
 * each prepended ahead of what came before. Pulled out as a pure function so
 * both the live run and tests (re-assembling from a recorded bundle) can
 * produce the identical string.
 */
export function composeSystemPrompt(
  basePrompt: string,
  parts: { layeredContext?: string; skillsText?: string; memoryPreamble?: string },
): string {
  let prompt = basePrompt;
  if (parts.layeredContext) prompt = parts.layeredContext + '\n\n' + prompt;
  if (parts.skillsText) prompt = parts.skillsText + '\n\n' + prompt;
  if (parts.memoryPreamble) prompt = parts.memoryPreamble + '\n\n' + prompt;
  return prompt;
}

export interface RunContextBundle {
  runId: string;
  createdAt: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  systemPromptSha256: string;
  /** Text actually injected this run, or null if none was injected. */
  memoryPreamble: string | null;
  layeredContext: string | null;
  skillsText: string | null;
  spec: { path: string; sha256: string } | null;
  /** Target URL with any userinfo (credentials) redacted. */
  targetUrl: string | null;
}

/** Pure builder for the repro bundle — no I/O beyond reading the spec file. */
export function buildRunContextBundle(params: {
  runId: string;
  systemPrompt: string;
  memoryPreamble?: string;
  layeredContext?: string;
  skillsText?: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  specPath?: string;
  targetUrl?: string;
}): RunContextBundle {
  let spec: RunContextBundle['spec'] = null;
  if (params.specPath) {
    try {
      const specYaml = fs.readFileSync(params.specPath, 'utf-8');
      spec = { path: params.specPath, sha256: sha256Hex(specYaml) };
    } catch {
      spec = { path: params.specPath, sha256: '' };
    }
  }
  return {
    runId: params.runId,
    createdAt: new Date().toISOString(),
    model: params.model,
    maxTurns: params.maxTurns,
    maxBudgetUsd: params.maxBudgetUsd,
    systemPromptSha256: sha256Hex(params.systemPrompt),
    memoryPreamble: params.memoryPreamble ?? null,
    layeredContext: params.layeredContext ?? null,
    skillsText: params.skillsText ?? null,
    spec,
    targetUrl: params.targetUrl ? redactUrlUserinfo(params.targetUrl) : null,
  };
}

/**
 * Write the bundle to `${outputDir}/run-context.json`. Best-effort: this must
 * never fail the run, so any error is caught and warned to stderr.
 */
export function writeRunContextBundle(outputDir: string, bundle: RunContextBundle): void {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, 'run-context.json');
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`  Failed to write run-context.json: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Browser session management
// ---------------------------------------------------------------------------

interface BrowserSession {
  browser: import('playwright').Browser;
  collector: import('./capture.js').CaptureCollector;
  observationRecorder: import('./observation.js').ObservationRecorder;
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
  const { ObservationRecorder } = await import('./observation.js');

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

  const observationRecorder = new ObservationRecorder({
    outputDir: captureOutputDir,
    page,
    collector,
  });

  // Step 0 = the initial goto. Without this, the runner-recorded trace would
  // be invisible for the navigation that establishes the starting page.
  await observationRecorder.beginStep('goto', { url: navigateUrl });
  await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const initialScreenshot = await collector.screenshot(page, 'initial');
  await observationRecorder.endStep({ success: true, screenshot: initialScreenshot });

  const mcpServer = createBrowserMcpServer(
    page,
    (name: string) => collector.screenshot(page, name),
    serverName,
    askUserHandler,
    observationRecorder,
  );

  return { browser, collector, observationRecorder, page, mcpServer };
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
  if (task === 'compile') {
    // Browserless LLM formula compilation (SP-o9z): reuse formula.ts's
    // recursive AST schema verbatim (definitions merged at the schema root)
    // so the model's `formula` output is structurally validated by the SDK
    // itself, in addition to the post-hoc validateFormula() check the CLI
    // command runs before writing anything to specify.formulas.yaml.
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        definitions: formulaSchema.definitions,
        properties: {
          results: {
            type: 'array',
            description: 'One entry per behavior successfully compiled into a formula. Skipping is correct — do not force a formula onto a behavior that doesn\'t warrant one.',
            items: {
              type: 'object',
              properties: {
                behavior: { type: 'string', description: 'Fully-qualified area-id/behavior-id this formula compiles' },
                formula: { $ref: '#/definitions/formula' },
                predicates_used: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Every distinct predicate name actually referenced in `formula`',
                },
                rationale: { type: 'string', description: 'Why this is a faithful, machine-checkable consequence of the behavior claim' },
              },
              required: ['behavior', 'formula', 'predicates_used', 'rationale'],
            },
          },
          skipped: {
            type: 'array',
            description: 'One entry per behavior that could not be compiled faithfully. This is the expected outcome for most behaviors.',
            items: {
              type: 'object',
              properties: {
                behavior: { type: 'string', description: 'Fully-qualified area-id/behavior-id' },
                reason: { type: 'string', description: 'Why this behavior cannot be compiled faithfully over the available predicates' },
              },
              required: ['behavior', 'reason'],
            },
          },
        },
        required: ['results', 'skipped'],
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

// ---------------------------------------------------------------------------
// stderr ring buffer helpers
// ---------------------------------------------------------------------------

const STDERR_CAPTURE_LIMIT = 8 * 1024; // 8 KB tail

/** Append data to a ring buffer, keeping only the last STDERR_CAPTURE_LIMIT bytes. */
function appendToRingBuffer(buf: string, data: string): string {
  const combined = buf + data;
  if (combined.length > STDERR_CAPTURE_LIMIT) {
    return combined.slice(combined.length - STDERR_CAPTURE_LIMIT);
  }
  return combined;
}

/**
 * Wrap an error to include captured Claude CLI stderr, if any.
 * Returns the original error when stderr is empty or already included.
 */
function wrapWithStderr(err: unknown, stderrTail: string): unknown {
  if (!stderrTail.trim()) return err;
  // Already includes our stderr marker — don't double-append.
  if (err instanceof Error && err.message.includes('— stderr:')) return err;
  const tail = stderrTail.trim();
  if (err instanceof AgentError) {
    // Preserve AgentError subtype/cost; just enhance the message.
    const enhanced = new AgentError(err.subtype, err.costUsd, err.cause);
    enhanced.message = `${err.message} — stderr: ${tail}`;
    enhanced.stack = err.stack;
    return enhanced;
  }
  if (err instanceof Error) {
    const enhanced = new Error(`${err.message} — stderr: ${tail}`);
    enhanced.stack = err.stack;
    return enhanced;
  }
  return new Error(`${String(err)} — stderr: ${tail}`);
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

  // Buffer the last STDERR_CAPTURE_LIMIT bytes from the claude CLI subprocess.
  // When the SDK throws 'Claude Code process exited with code N' the real cause
  // (auth error, quota, model-not-found, …) is in this buffer.
  let stderrBuf = '';
  const optionsWithStderr: Options = {
    ...queryOptions,
    stderr: (data: string) => {
      stderrBuf = appendToRingBuffer(stderrBuf, data);
      // Forward to caller's handler if one was provided.
      if (queryOptions.stderr) queryOptions.stderr(data);
    },
  };

  const q = query({ prompt, options: optionsWithStderr });

  // Timeout for initial connection — if no message arrives in 30s, bail
  const INIT_TIMEOUT_MS = 30_000;
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  const initTimeout = new Promise<never>((_, reject) => {
    initTimer = setTimeout(() => {
      if (!receivedFirstMessage) {
        const base =
          'Timed out waiting for API connection (30s). ' +
          'This usually means authentication failed. ' +
          'Check your ANTHROPIC_API_KEY and try again.';
        // Include any stderr captured so far (e.g. the auth error line).
        const msg = stderrBuf.trim() ? `${base} — stderr: ${stderrBuf.trim()}` : base;
        reject(new Error(msg));
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
          throw wrapWithStderr(
            new Error(`Authentication failed: ${authMsg.error}`),
            stderrBuf,
          ) as Error;
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
        throw wrapWithStderr(new AgentError(message.subtype, costUsd), stderrBuf);
      }
    }
    }
  } catch (err) {
    // Wrap any error that bubbles out of the query iteration with the captured
    // stderr tail. This covers the most common case: the SDK throws
    // 'Claude Code process exited with code 1' and discards subprocess stderr.
    throw wrapWithStderr(err, stderrBuf);
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

  // Single run id shared by every MCP server this run spins up (memory,
  // feedback, decisions) and recorded in run-context.json, so all events
  // from one run can be correlated by that id.
  const runId = `run_${randomUUID().slice(0, 8)}`;

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

    // Sandbox: web-target sessions must be restricted to the browser MCP
    // channel (plus the file I/O they need for evidence). Any action taken
    // outside that channel is invisible to the CaptureCollector, so
    // deterministic verdicts are only sound if the channel is exclusive —
    // not merely the one we expect the model to prefer.
    const fileTools: string[] = ['Read'];
    if (opts.task === 'capture' || opts.task === 'compare' || opts.task === 'verify') {
      fileTools.push('Write');
    }

    // `allowedTools` (below) only auto-approves listed tools for the
    // permission prompt — it does NOT restrict which tools are available to
    // the model (see node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
    // "To restrict which tools are available, use the `tools` option
    // instead."). Combined with permissionMode 'bypassPermissions' +
    // allowDangerouslySkipPermissions, omitting an explicit restriction
    // would leave the full built-in tool set (Bash, WebFetch, WebSearch,
    // etc.) available regardless of `allowedTools`. `disallowedTools`
    // removes tools from the model's context outright, even if otherwise
    // allowed, so it's the mechanism that actually restricts the channel.
    //
    // Scoped to web-target sessions only (a browser session was launched,
    // i.e. opts.url/opts.remoteUrl+opts.localUrl set). Browserless
    // ("compile"-style) and future cli-target runs may legitimately need
    // Bash to drive the target; that restriction is left for SP-efd.
    const hasBrowserSession = sessions.length > 0;
    const disallowedTools: string[] = hasBrowserSession
      ? ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch']
      : [];

    // Learned memory: only verify tasks participate. Read the store and
    // prepend the summary to the system prompt so the agent starts with
    // prior knowledge; expose memory_record + memory_list tools so the
    // agent can write back durable lessons.
    let systemPrompt = opts.systemPrompt;
    const memoryTools: string[] = [];
    const feedbackTools: string[] = [];
    const decisionTools: string[] = [];

    // Text actually injected into the system prompt this run, tracked
    // separately so it can be recorded verbatim in run-context.json
    // (SP-bhm). When opts.contextOverride is set (specify verify
    // --with-context), we bypass live memory/layered/skills fetches and
    // reuse the recorded text instead, for a byte-identical re-verify.
    let layeredContextText: string | undefined;
    let skillsText: string | undefined;
    let memoryPreambleText: string | undefined;

    // Layered context (user / project / per-spec observations) is loaded for
    // every task — not just verify — since project-level guidance and user
    // preferences apply to capture/replay/compare too.
    if (opts.spec) {
      try {
        layeredContextText = opts.contextOverride
          ? opts.contextOverride.layeredContext
          : renderLayeredPrompt(loadLayeredContext(opts.spec));
      } catch (err) {
        process.stderr.write(`  Layered context unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // Active learned skills are experimental. Keep them out of the default
      // prompt unless the operator explicitly opts in.
      if (learnedSkillsEnabled() || opts.contextOverride) {
        try {
          skillsText = opts.contextOverride
            ? opts.contextOverride.skillsText
            : renderActiveSkillsPrompt(opts.spec);
        } catch (err) {
          process.stderr.write(`  Active skills unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }

    // Learned memory: only verify tasks participate. Read the store and
    // prepend the summary to the system prompt so the agent starts with
    // prior knowledge; expose memory_record + memory_list tools so the
    // agent can write back durable lessons.
    let verifyMemoryScope: MemoryScope | undefined;
    let verifyMemoryProvider: MemoryProvider | undefined;
    if (opts.task === 'verify' && opts.spec) {
      try {
        const { loadSpec } = await import('../spec/parser.js');
        const spec = loadSpec(opts.spec);
        const target = {
          type: spec.target.type as 'web' | 'api' | 'cli',
          url: (spec.target as { url?: string }).url,
          binary: (spec.target as { binary?: string }).binary,
        };
        const provider: MemoryProvider = honchoFromEnv() ?? defaultMemoryProvider();
        const scope: MemoryScope = { specPath: opts.spec, specId: spec.name, target };
        verifyMemoryScope = scope;
        verifyMemoryProvider = provider;
        memoryPreambleText = opts.contextOverride
          ? opts.contextOverride.memoryPreamble
          : await provider.prefetch(scope);
        const memoryServer = createMemoryMcpServer({
          scope,
          runId,
          provider,
        });
        mcpServers.memory = memoryServer;
        memoryTools.push('mcp__memory__memory_record', 'mcp__memory__memory_list');
      } catch (err) {
        // Non-fatal: memory is a learning aid, not a correctness requirement.
        process.stderr.write(`  Memory store unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      // Outbound ticket-filing tool. Default sink is `bd`; flip to HTTP by
      // setting SPECIFY_FEEDBACK_URL. Loaded only for verify because that's
      // the task whose findings warrant a ticket.
      try {
        const { loadSpec } = await import('../spec/parser.js');
        const spec = loadSpec(opts.spec);
        const feedbackServer = createFeedbackMcpServer({
          specId: spec.name,
          runId,
          sink: feedbackSinkFromEnv(),
        });
        mcpServers.feedback = feedbackServer;
        feedbackTools.push('mcp__feedback__file_ticket');
      } catch (err) {
        process.stderr.write(`  Feedback tool unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Compose the final system prompt once all injected parts are known, so
    // the recorded texts and the actual prompt sent to the model always
    // agree (see composeSystemPrompt / run-context.json below).
    systemPrompt = composeSystemPrompt(systemPrompt, {
      layeredContext: layeredContextText,
      skillsText,
      memoryPreamble: memoryPreambleText,
    });

    // Decisions queue: available for verify and capture. Capture benefits from
    // being able to ask "is this an actual broken page or expected for an
    // unauthenticated user?" without the agent having to make that call alone.
    if ((opts.task === 'verify' || opts.task === 'capture') && opts.spec) {
      try {
        const { loadSpec } = await import('../spec/parser.js');
        const spec = loadSpec(opts.spec);
        const target = {
          type: spec.target.type as 'web' | 'api' | 'cli',
          url: (spec.target as { url?: string }).url,
          binary: (spec.target as { binary?: string }).binary,
        };
        const memoryScope: MemoryScope = verifyMemoryScope ?? {
          specPath: opts.spec,
          specId: spec.name,
          target,
        };
        const memoryProvider = verifyMemoryProvider ?? defaultMemoryProvider();
        const decisionsServer = createDecisionsMcpServer({
          specId: spec.name,
          runId,
          memoryScope,
          memoryProvider,
        });
        mcpServers.decisions = decisionsServer;
        decisionTools.push('mcp__decisions__file_decision');
      } catch (err) {
        process.stderr.write(`  Decisions tool unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
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
        ...feedbackTools,
        ...decisionTools,
      ],
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: opts.cwd ?? process.cwd(),
      maxTurns: envNumber('SPECIFY_MAX_TURNS', 200),
      maxBudgetUsd: envNumber('SPECIFY_MAX_BUDGET_USD', 5),
      persistSession: false,
      ...(outputFormat ? { outputFormat } : {}),
    };

    // Persist the repro bundle: sha256 of the final systemPrompt, the
    // rendered preamble texts, model/limits, spec identity, and the redacted
    // target URL, all keyed to the shared runId. Best-effort — writing this
    // must never fail the run.
    try {
      const runContextBundle = buildRunContextBundle({
        runId,
        systemPrompt,
        memoryPreamble: memoryPreambleText,
        layeredContext: layeredContextText,
        skillsText,
        model: queryOptions.model as string,
        maxTurns: queryOptions.maxTurns as number,
        maxBudgetUsd: queryOptions.maxBudgetUsd as number,
        specPath: opts.spec,
        targetUrl: opts.url ?? opts.remoteUrl ?? opts.localUrl,
      });
      writeRunContextBundle(opts.outputDir, runContextBundle);
    } catch (err) {
      process.stderr.write(`  Failed to build run-context.json: ${err instanceof Error ? err.message : String(err)}\n`);
    }

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
      try {
        session.observationRecorder.save();
      } catch {
        // Observation trace is best-effort; never break session teardown.
      }
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

export const _internals = { envNumber };
