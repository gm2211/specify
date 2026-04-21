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
import {
  getVerifyPrompt,
  getCapturePrompt,
  getComparePrompt,
  getReplayPrompt,
} from '../agent/prompts.js';
import { loadSpec, specToYaml } from '../spec/parser.js';

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
}

export interface InboxMessage {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
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
  /** Guard so we only run one stateless SDK query at a time to avoid
   * fighting over stdout/stderr and Playwright resources. */
  private statelessInFlight = false;
  private statelessQueue: InboxMessage[] = [];

  /** Wipe state (tests only). */
  reset(): void {
    for (const key of this.sessions.keys()) this.closeSession(key);
    this.history.clear();
    this.statelessQueue.length = 0;
    this.statelessInFlight = false;
  }

  get(id: string): InboxMessage | undefined {
    return this.history.get(id);
  }

  list(): InboxMessage[] {
    return Array.from(this.history.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  sessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  submit(req: InboxRequest): InboxMessage {
    const id = req.id ?? `msg_${randomUUID().slice(0, 8)}`;
    const message: InboxMessage = {
      id,
      createdAt: new Date().toISOString(),
      status: 'queued',
      request: req,
      session: req.mode === 'attach' ? req.session ?? 'default' : undefined,
    };
    this.remember(message);
    eventBus.send('inbox:received', {
      id,
      task: req.task,
      mode: req.mode ?? 'stateless',
      sender: req.sender,
    }, id);

    if (req.mode === 'attach') {
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

  private async runStatelessOne(message: InboxMessage): Promise<void> {
    message.status = 'running';
    eventBus.send('inbox:running', { id: message.id }, message.id);
    try {
      const runnerOpts = this.buildRunnerOptions(message);
      message.outputDir = runnerOpts.outputDir;
      const result = await runnerImpl(runnerOpts);
      message.status = 'completed';
      message.result = result;
      message.resultPath = this.persistResult(message, runnerOpts.outputDir, result);
      eventBus.send('inbox:completed', {
        id: message.id,
        costUsd: result.costUsd,
        resultPath: message.resultPath,
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
      session = this.startSession(sessionKey, message);
      this.sessions.set(sessionKey, session);
      // The first message becomes the initial prompt of the session;
      // MessageInjector yields it first. We mark it running immediately.
      message.status = 'running';
      eventBus.send('inbox:running', { id: message.id, session: sessionKey }, message.id);
      session.activeMessage = message.id;
      return;
    }

    // Existing session — inject this message.
    message.status = 'running';
    session.activeMessage = message.id;
    eventBus.send('inbox:running', { id: message.id, session: sessionKey }, message.id);
    session.injector.inject(message.request.prompt, 'next');
  }

  private startSession(sessionKey: string, initial: InboxMessage): PersistentSession {
    const injector = new MessageInjector(initial.request.prompt);
    const runnerOpts = this.buildRunnerOptions(initial);
    runnerOpts.messageInjector = injector;
    initial.outputDir = runnerOpts.outputDir;

    const done = runnerImpl(runnerOpts).then(
      (result) => {
        // Session ended — the agent returned a final result. In chat-style
        // mode this normally only happens on close() or max_turns.
        initial.status = 'completed';
        initial.result = result;
        initial.resultPath = this.persistResult(initial, runnerOpts.outputDir, result);
        eventBus.send('inbox:session_ended', {
          session: sessionKey,
          costUsd: result.costUsd,
          resultPath: initial.resultPath,
        }, initial.id);
        this.sessions.delete(sessionKey);
      },
      (err) => {
        this.fail(initial, err);
        this.sessions.delete(sessionKey);
      },
    );

    return {
      id: sessionKey,
      injector,
      activeMessage: initial.id,
      queue: [],
      done,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildRunnerOptions(message: InboxMessage): SdkRunnerOptions {
    const req = message.request;
    const outputDir = path.resolve(
      req.outputDir ?? path.join('.specify', 'inbox', message.id),
    );

    const { systemPrompt, userPrompt } = buildPrompts(req, outputDir);

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
    eventBus.send('inbox:failed', { id: message.id, error: msg }, message.id);
  }
}

function buildPrompts(req: InboxRequest, outputDir: string): { systemPrompt: string; userPrompt: string } {
  if (req.task === 'verify') {
    if (!req.spec) {
      throw new Error('verify task requires `spec` (path to spec file)');
    }
    const spec = loadSpec(path.resolve(req.spec));
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

export const inbox = new InboxRegistry();
