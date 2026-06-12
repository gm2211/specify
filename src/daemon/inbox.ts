/**
 * src/daemon/inbox.ts — Inbox message queue and dispatcher for `specify daemon`.
 *
 * An inbox message is a task submitted by another agent (human or automated)
 * over HTTP. Each message is dispatched in one of two modes:
 *
 *   - stateless (default): a fresh Agent SDK query runs per message.
 *     Idle process = 0 tokens, fully isolated, bounded cost per message.
 *
 *   - attach: the message is injected into a persistent SDK session keyed
 *     by `session`. The session is lazily started on first attach and
 *     holds context across messages. Idle between messages = 0 tokens
 *     (the SDK blocks on the MessageInjector's AsyncIterable).
 *
 * Results and intermediate agent events are delivered through the existing
 * eventBus, tagged with the message id so the HTTP layer can stream them.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eventBus } from '../agent/event-bus.js';
import { MessageInjector } from '../agent/message-injector.js';
import { runSpecifyAgent } from '../agent/sdk-runner.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';
import { getPool } from './worker-pool.js';
import {
  getVerifyPrompt,
  getCapturePrompt,
  getComparePrompt,
  getReplayPrompt,
} from '../agent/prompts.js';
import { resolveSpec, specSourceFromEnv } from '../agent/spec-loader.js';
import { loadSpec, specToYaml } from '../spec/parser.js';
import type { Spec } from '../spec/types.js';
import { saveMessage, loadMessages, pruneMessages } from './inbox-state.js';

export type InboxMode = 'stateless' | 'attach';

export interface InboxRequest {
  /** Optional explicit message id; generated if omitted. */
  id?: string;
  /** Task to run. 'freeform' uses `prompt` as both system and user input. */
  task: 'verify' | 'capture' | 'compare' | 'replay' | 'freeform';
  /** Freeform instruction from the caller. */
  prompt: string;
  /** Optional URL override (web/api targets). */
  url?: string;
  /** Optional remote URL (compare). */
  remoteUrl?: string;
  /** Optional local URL (compare). */
  localUrl?: string;
  /** Optional path to a spec file to use as context. */
  spec?: string;
  /** Optional capture directory (replay). */
  captureDir?: string;
  /** Output directory; defaults to .specify/<task>/<msgId>. */
  outputDir?: string;
  /** Dispatch mode. */
  mode?: InboxMode;
  /** Session key for attach mode. Creates the session if it does not exist. */
  session?: string;
  /** Sender identifier for audit/logging. */
  sender?: string;
  /**
   * Workload metadata forwarded by the k8s-watcher. Typed here so callers
   * (watcher debounce check) can inspect it without unsafe casts.
   */
  metadata?: {
    kind?: string;
    namespace?: string;
    name?: string;
    image?: string;
    resourceVersion?: string;
  };
}

export interface InboxMessage {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  request: InboxRequest;
  /** Populated once the message finishes. */
  result?: SdkRunnerResult;
  /** Path to the persisted result JSON on disk (if structured output). */
  resultPath?: string;
  /** Absolute output directory used by the runner. */
  outputDir?: string;
  /** Populated on failure. */
  error?: string;
  /** Session id for attach-mode messages. */
  session?: string;
  /** ISO timestamp when the job began executing. */
  startedAt?: string;
  /** ISO timestamp when the job finished. */
  completedAt?: string;
}

interface PersistentSession {
  id: string;
  injector: MessageInjector;
  /** The currently-executing message id, or null while waiting. */
  activeMessage: string | null;
  /** Messages queued behind the active one for the same session. */
  queue: InboxMessage[];
  /** Promise that resolves when the underlying SDK query exits. */
  done: Promise<void>;
}

const MAX_HISTORY = 500;

type RunnerFn = typeof runSpecifyAgent;
let runnerImpl: RunnerFn = runSpecifyAgent;

/** Override the SDK runner (tests only). Returns the previous impl. */
export function __setRunnerForTesting(fn: RunnerFn): RunnerFn {
  const prev = runnerImpl;
  runnerImpl = fn;
  return prev;
}

export class InboxRegistry {
  private history = new Map<string, InboxMessage>();
  private sessions = new Map<string, PersistentSession>();
  /** Fallback serialization when no worker pool is configured (tests or
   *  in-process-only deployments). When a pool is configured, the pool
   *  enforces concurrency instead. */
  private statelessInFlight = false;
  private statelessQueue: InboxMessage[] = [];

  /** Wipe state (tests only). Does NOT delete disk state — tests manage the
   *  dir via SPECIFY_INBOX_STATE_DIR env var. */
  reset(): void {
    for (const key of this.sessions.keys()) this.closeSession(key);
    this.history.clear();
    this.statelessQueue.length = 0;
    this.statelessInFlight = false;
  }

  /** Persist a message to disk and prune the registry to MAX_HISTORY records.
   *  Persistence failure must never break dispatch — errors go to stderr. */
  private persist(message: InboxMessage): void {
    try {
      saveMessage(message);
      pruneMessages(MAX_HISTORY);
    } catch (err) {
      process.stderr.write(`[inbox] persist failed for ${message.id}: ${(err as Error).message}\n`);
    }
  }

  /** Restore inbox history from disk after a restart. Any record that was
   *  'queued' or 'running' is marked 'interrupted' — those jobs will never
   *  complete because the process that was executing them is gone.
   *  Call this once during server startup, before k8s watcher / HTTP traffic. */
  restoreFromDisk(): { restored: number; interrupted: number } {
    const records = loadMessages();
    records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    let interrupted = 0;
    for (const record of records) {
      this.remember(record);
      if (record.status === 'queued' || record.status === 'running') {
        record.status = 'interrupted';
        record.error = 'daemon restarted while job was in flight';
        this.persist(record);
        eventBus.send('inbox:interrupted', { id: record.id, error: record.error }, record.id);
        interrupted++;
      }
    }

    return { restored: records.length, interrupted };
  }

  get(id: string): InboxMessage | undefined {
    return this.history.get(id);
  }

  list(): InboxMessage[] {
    return Array.from(this.history.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  /**
   * Returns the first queued/running verify message that targets the same
   * workload — by watcher metadata (namespace+name, and image when both
   * sides have one) or by effective url (covers url-based verify posts
   * from deploy scripts, since submit() defaults url from
   * SPECIFY_TARGET_URL for watcher posts too).
   */
  findActiveVerify(
    target: { namespace: string; name: string; image?: string },
    effectiveUrl?: string,
  ): InboxMessage | undefined {
    for (const msg of this.history.values()) {
      if (msg.status !== 'queued' && msg.status !== 'running') continue;
      if (msg.request.task !== 'verify') continue;
      const meta = msg.request.metadata;
      // Match by workload metadata (namespace + name, image optional).
      if (
        meta?.namespace === target.namespace &&
        meta?.name === target.name &&
        (!target.image || !meta.image || meta.image === target.image)
      ) {
        return msg;
      }
      // Match by effective url (deploy-script posts have no metadata but
      // share the same url as watcher posts once submit() fills in
      // SPECIFY_TARGET_URL).
      if (effectiveUrl != null && msg.request.url === effectiveUrl) {
        return msg;
      }
    }
    return undefined;
  }

  sessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  submit(req: InboxRequest): InboxMessage {
    const id = req.id ?? `msg_${randomUUID().slice(0, 8)}`;
    // Default url from SPECIFY_TARGET_URL when caller didn't supply one.
    // Lets the QA pod be configured once via Terraform and have every
    // inbox-driven verify run against the same target — including the
    // ones synthesized by the k8s rollout watcher, which has no URL of
    // its own.
    const envTargetUrl = process.env.SPECIFY_TARGET_URL?.trim();
    const effectiveReq: InboxRequest = req.url || !envTargetUrl
      ? req
      : { ...req, url: envTargetUrl };
    const message: InboxMessage = {
      id,
      createdAt: new Date().toISOString(),
      status: 'queued',
      request: effectiveReq,
      session: effectiveReq.mode === 'attach' ? effectiveReq.session ?? 'default' : undefined,
    };
    this.remember(message);
    this.persist(message);
    eventBus.send('inbox:received', {
      id,
      task: effectiveReq.task,
      mode: effectiveReq.mode ?? 'stateless',
      sender: effectiveReq.sender,
    }, id);

    if (effectiveReq.mode === 'attach') {
      this.dispatchAttach(message).catch((err) => this.fail(message, err));
    } else {
      this.dispatchStateless(message).catch((err) => this.fail(message, err));
    }
    return message;
  }

  /** Close and drop a persistent session. */
  closeSession(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey);
    if (!s) return false;
    s.injector.close();
    this.sessions.delete(sessionKey);
    eventBus.send('inbox:session_closed', { session: sessionKey });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Stateless
  // ---------------------------------------------------------------------------

  private async dispatchStateless(message: InboxMessage): Promise<void> {
    const pool = getPool();
    if (pool) {
      // Worker pool enforces its own concurrency (maxConcurrent). Queuing
      // and slot management live there.
      this.runStatelessViaPool(message).catch((err) => this.fail(message, err));
      return;
    }
    // Fallback: in-process, serialized (tests + __setRunnerForTesting path).
    this.statelessQueue.push(message);
    if (this.statelessInFlight) return;
    this.statelessInFlight = true;
    try {
      while (this.statelessQueue.length > 0) {
        const next = this.statelessQueue.shift()!;
        await this.runStatelessOne(next);
      }
    } finally {
      this.statelessInFlight = false;
    }
  }

  private async runStatelessViaPool(message: InboxMessage): Promise<void> {
    message.status = 'running';
    message.startedAt = new Date().toISOString();
    this.persist(message);
    eventBus.send('inbox:running', { id: message.id }, message.id);
    try {
      const runnerOpts = await this.buildRunnerOptions(message);
      message.outputDir = runnerOpts.outputDir;
      const pool = getPool()!;
      const result = await pool.dispatch(message.id, runnerOpts);
      message.status = 'completed';
      message.completedAt = new Date().toISOString();
      message.result = result;
      message.resultPath = this.persistResult(message, runnerOpts.outputDir, result);
      this.persist(message);
      eventBus.send('inbox:completed', {
        id: message.id,
        costUsd: result.costUsd,
        resultPath: message.resultPath,
        startedAt: message.startedAt,
        completedAt: message.completedAt,
      }, message.id);
    } catch (err) {
      this.fail(message, err);
    }
  }

  private async runStatelessOne(message: InboxMessage): Promise<void> {
    message.status = 'running';
    message.startedAt = new Date().toISOString();
    this.persist(message);
    eventBus.send('inbox:running', { id: message.id }, message.id);
    try {
      const runnerOpts = await this.buildRunnerOptions(message);
      message.outputDir = runnerOpts.outputDir;
      const result = await runnerImpl(runnerOpts);
      message.status = 'completed';
      message.completedAt = new Date().toISOString();
      message.result = result;
      message.resultPath = this.persistResult(message, runnerOpts.outputDir, result);
      this.persist(message);
      eventBus.send('inbox:completed', {
        id: message.id,
        costUsd: result.costUsd,
        resultPath: message.resultPath,
        startedAt: message.startedAt,
        completedAt: message.completedAt,
      }, message.id);
    } catch (err) {
      this.fail(message, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Attach (persistent session)
  // ---------------------------------------------------------------------------

  private async dispatchAttach(message: InboxMessage): Promise<void> {
    const sessionKey = message.session ?? 'default';
    let session = this.sessions.get(sessionKey);

    if (!session) {
      const injector = new MessageInjector(message.request.prompt);
      session = {
        id: sessionKey,
        injector,
        activeMessage: message.id,
        queue: [],
        done: this.startSession(sessionKey, message, injector),
      };
      this.sessions.set(sessionKey, session);
      // The first message becomes the initial prompt of the session;
      // MessageInjector yields it first. We mark it running immediately.
      message.status = 'running';
      message.startedAt = new Date().toISOString();
      this.persist(message);
      eventBus.send('inbox:running', { id: message.id, session: sessionKey }, message.id);
      session.activeMessage = message.id;
      return;
    }

    // Existing session — inject this message.
    message.status = 'running';
    message.startedAt = new Date().toISOString();
    session.activeMessage = message.id;
    this.persist(message);
    eventBus.send('inbox:running', { id: message.id, session: sessionKey }, message.id);
    session.injector.inject(message.request.prompt, 'next');
  }

  private async startSession(sessionKey: string, initial: InboxMessage, injector: MessageInjector): Promise<void> {
    try {
      const runnerOpts = await this.buildRunnerOptions(initial);
      runnerOpts.messageInjector = injector;
      initial.outputDir = runnerOpts.outputDir;

      const result = await runnerImpl(runnerOpts);
      // Session ended — the agent returned a final result. In chat-style
      // mode this normally only happens on close() or max_turns.
      initial.status = 'completed';
      initial.completedAt = new Date().toISOString();
      initial.result = result;
      initial.resultPath = this.persistResult(initial, runnerOpts.outputDir, result);
      this.persist(initial);
      eventBus.send('inbox:session_ended', {
        session: sessionKey,
        costUsd: result.costUsd,
        resultPath: initial.resultPath,
      }, initial.id);
    } catch (err) {
      this.fail(initial, err);
    } finally {
      this.sessions.delete(sessionKey);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async buildRunnerOptions(message: InboxMessage): Promise<SdkRunnerOptions> {
    const req = message.request;
    const outputDir = path.resolve(
      req.outputDir ?? path.join('.specify', 'inbox', message.id),
    );

    const { systemPrompt, userPrompt, specPath } = await buildPrompts(req, outputDir);

    // task=freeform maps to a 'verify' runner shape (single browser, Read/Write
    // tools, no structured output schema). 'verify' runner + freeform system
    // prompt gives the agent a web browser + filesystem, which covers the
    // common "go check the site" case.
    const runnerTask: SdkRunnerOptions['task'] =
      req.task === 'freeform' ? 'verify' : req.task;

    const opts: SdkRunnerOptions = {
      task: runnerTask,
      systemPrompt,
      userPrompt,
      outputDir,
    };
    if (req.url) opts.url = req.url;
    if (req.remoteUrl) opts.remoteUrl = req.remoteUrl;
    if (req.localUrl) opts.localUrl = req.localUrl;
    if (req.spec) opts.spec = req.spec;
    else if (specPath) opts.spec = specPath;
    if (req.captureDir) opts.captureDir = req.captureDir;
    return opts;
  }

  /** Persist structured output to disk so external tools can read results
   *  without streaming. Mirrors the shape `specify verify` writes. */
  private persistResult(message: InboxMessage, outputDir: string, result: SdkRunnerResult): string | undefined {
    if (!result.structuredOutput) return undefined;
    const filename =
      message.request.task === 'compare' ? 'compare-result.json'
      : message.request.task === 'verify' ? 'verify-result.json'
      : message.request.task === 'capture' ? 'capture-result.json'
      : message.request.task === 'replay' ? 'replay-result.json'
      : 'result.json';
    const full = path.join(outputDir, filename);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify({
      id: message.id,
      task: message.request.task,
      structuredOutput: result.structuredOutput,
    }, null, 2), 'utf-8');
    return full;
  }

  private remember(message: InboxMessage): void {
    this.history.set(message.id, message);
    if (this.history.size > MAX_HISTORY) {
      const firstKey = this.history.keys().next().value;
      if (firstKey) this.history.delete(firstKey);
    }
  }

  private fail(message: InboxMessage, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    message.status = 'failed';
    message.error = msg;
    this.persist(message);
    eventBus.send('inbox:failed', { id: message.id, error: msg }, message.id);
  }
}

interface PromptBundle {
  systemPrompt: string;
  userPrompt: string;
  specPath?: string;
}

async function buildPrompts(req: InboxRequest, outputDir: string): Promise<PromptBundle> {
  if (req.task === 'verify') {
    const { spec, specPath } = await resolveVerifySpec(req);
    const specYaml = specToYaml(spec);
    const targetUrl = req.url
      ?? (spec.target.type === 'web' || spec.target.type === 'api'
        ? (spec.target as { url: string }).url
        : undefined);
    return {
      systemPrompt: getVerifyPrompt(specYaml),
      userPrompt: req.prompt?.trim()
        ? req.prompt
        : targetUrl
          ? `Verify ${targetUrl} against the behavioral spec.`
          : `Verify the target against the behavioral spec.`,
      specPath,
    };
  }

  if (req.task === 'capture') {
    if (!req.url) throw new Error('capture task requires `url`');
    const specOutputPath = path.resolve(
      req.spec ?? path.join(path.dirname(outputDir), 'spec.yaml'),
    );
    return {
      systemPrompt: getCapturePrompt(req.url, specOutputPath),
      userPrompt: req.prompt?.trim()
        ? req.prompt
        : `Explore ${req.url} and generate a comprehensive behavioral spec.`,
    };
  }

  if (req.task === 'compare') {
    if (!req.remoteUrl || !req.localUrl) {
      throw new Error('compare task requires `remoteUrl` and `localUrl`');
    }
    return {
      systemPrompt: getComparePrompt(req.remoteUrl, req.localUrl, outputDir),
      userPrompt: req.prompt?.trim()
        ? req.prompt
        : `Compare remote ${req.remoteUrl} against local ${req.localUrl}.`,
    };
  }

  if (req.task === 'replay') {
    if (!req.captureDir || !req.url) {
      throw new Error('replay task requires `captureDir` and `url`');
    }
    return {
      systemPrompt: getReplayPrompt(req.captureDir, req.url),
      userPrompt: req.prompt?.trim()
        ? req.prompt
        : `Replay traffic from ${req.captureDir} against ${req.url}.`,
    };
  }

  // freeform: caller drives. Minimal system prompt, prompt is the directive.
  return {
    systemPrompt: `You are Specify operating in daemon inbox mode.
Another agent has sent you a task. Follow its instructions exactly.
If the instruction cannot be safely completed, respond with a short
explanation and stop. Prefer read-only operations unless told otherwise.
Output directory for any files you create: ${outputDir}`,
    userPrompt: req.prompt,
  };
}

async function resolveVerifySpec(req: InboxRequest): Promise<{ spec: Spec; specPath?: string }> {
  if (req.spec) {
    return { spec: loadSpec(path.resolve(req.spec)) };
  }

  const source = specSourceFromEnv();
  if (!source) {
    throw new Error(
      'verify task requires `spec` (path to spec file) or one configured spec source: SPECIFY_SPEC_INLINE_PATH / SPECIFY_SPEC_URL / SPECIFY_SPEC_GIT_REPO',
    );
  }

  const resolved = await resolveSpec(source);
  return {
    spec: resolved.spec,
    specPath: source.kind === 'inline' ? path.resolve(source.path) : undefined,
  };
}

export const inbox = new InboxRegistry();
