/**
 * src/daemon/worker-pool.ts — Fork-per-job dispatcher for stateless inbox runs.
 *
 * The parent process owns the inbox queue + HTTP server. When a stateless
 * message is dispatched, we:
 *
 *   1. Wait for a free slot (up to maxConcurrent jobs in flight), subject to
 *      a bounded wait queue (SP-1xd) — beyond that bound, dispatch() rejects
 *      immediately instead of growing the queue without limit.
 *   2. `child_process.fork` a worker running src/daemon/worker.js.
 *   3. Send it the job over IPC.
 *   4. Relay the worker's `event` messages onto our own eventBus so the SSE
 *      stream sees them; resolve with the worker's `result` message.
 *
 * SP-1xd (pool wedges): the Agent SDK can stop yielding messages after
 * connecting — including subscription-limit stalls — without ever
 * rejecting/resolving its query. Before this file, a stalled worker held its
 * slot forever: dispatch() awaited runOne() with no timeout, so
 * maxConcurrent workers wedging one at a time eventually starved the whole
 * pool while /health kept reporting green. Fixes here:
 *
 *   - A bounded per-job timeout starts once a slot is actually acquired
 *     (not while queued). On expiry we ask the worker to abort gracefully
 *     (`{ kind: 'cancel' }`, mirrored onto the SDK's AbortController — see
 *     worker.ts / sdk-runner.ts), release the slot immediately so the next
 *     waiter can run, and fall back to a process-tree SIGKILL if the worker
 *     hasn't exited by the end of a grace period. The worker is forked
 *     `detached: true` (its own process group) specifically so that
 *     fallback — `process.kill(-pid, 'SIGKILL')` — reaches every descendant
 *     it spawned (Playwright's browser, the `claude` CLI subprocess), not
 *     just the immediate forked process.
 *   - `stats()` exposes active/queued counts, the oldest in-flight job's
 *     age, and a `wedged` count of jobs currently being torn down after a
 *     timeout — /health surfaces this instead of staying green.
 *
 * Attach-mode sessions keep their SDK query in-process (serial by design), so
 * they bypass the pool entirely.
 */

import { fork } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventBus } from '../agent/event-bus.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve the worker entry script (compiled .js under dist/). */
function resolveWorkerPath(): string {
  // When this file runs from dist/src/daemon, worker.js sits next to it.
  return path.join(__dirname, 'worker.js');
}

/** Functions in SdkRunnerOptions cannot cross IPC — strip them before sending. */
function serializableOpts(opts: SdkRunnerOptions): SdkRunnerOptions {
  const { onBehaviorProgress: _1, askUserHandler: _2, messageInjector: _3, abortSignal: _4, ...rest } = opts;
  return rest as SdkRunnerOptions;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Wall-clock budget for one job once its slot is acquired. Default 15m —
 *  generous for a browser-driven verify/capture run, still finite. */
export const DEFAULT_JOB_TIMEOUT_MS = envMs('SPECIFY_DAEMON_JOB_TIMEOUT_MS', 15 * 60_000);
/** Grace period after a graceful cancel before the process-tree SIGKILL fallback. */
export const DEFAULT_KILL_GRACE_MS = envMs('SPECIFY_DAEMON_KILL_GRACE_MS', 5_000);
/** Max jobs allowed to wait for a free slot before dispatch() rejects new ones. */
export const DEFAULT_MAX_QUEUE_LENGTH = envMs('SPECIFY_DAEMON_MAX_QUEUE', 50);

/**
 * Minimal surface of child_process.ChildProcess this module depends on — a
 * real ChildProcess satisfies it structurally. Lets tests inject a fake
 * worker (`spawnWorker` pool option) instead of forking a real process.
 */
export interface WorkerHandle {
  readonly pid?: number;
  send(msg: Record<string, unknown>): unknown;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: 'message', listener: (msg: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

function forkWorker(): WorkerHandle {
  const workerPath = resolveWorkerPath();
  return fork(workerPath, [], {
    // Keep stderr visible so users can still see Playwright / SDK logs.
    // Workers prefix nothing; parent stderr will interleave — acceptable
    // because primary telemetry is the event bus, tagged by jobId.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // detached: true makes the worker its own process-group leader, so any
    // descendants it spawns inherit that group. That's what lets the
    // timeout fallback below signal the whole tree via `process.kill(-pid)`
    // instead of only the immediate forked process.
    detached: true,
  }) as unknown as WorkerHandle;
}

/** Thrown by dispatch() when the wait queue is already at its bound. */
export class WorkerPoolQueueFullError extends Error {
  constructor(public readonly queued: number, public readonly maxQueueLength: number) {
    super(`daemon worker queue is full (${queued}/${maxQueueLength} waiting) — try again later`);
    this.name = 'WorkerPoolQueueFullError';
  }
}

/** Thrown by dispatch() when a job exceeds its per-job timeout. */
export class WorkerJobTimeoutError extends Error {
  constructor(public readonly jobId: string, public readonly timeoutMs: number) {
    super(`job ${jobId} exceeded the ${timeoutMs}ms worker timeout and was aborted`);
    this.name = 'WorkerJobTimeoutError';
  }
}

interface PendingSlot {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface ActiveJob {
  jobId: string;
  startedAt: number;
}

export interface WorkerPoolStats {
  maxConcurrent: number;
  /** Slots currently occupied. A timed-out job's slot is freed immediately
   *  (see class doc) so this never includes jobs already being torn down. */
  active: number;
  queued: number;
  maxQueueLength: number;
  /** Age in ms of the longest-running in-flight job, or null if idle. */
  oldestActiveMs: number | null;
  /** Jobs whose timeout fired and are being cancelled/killed but haven't
   *  been confirmed dead yet. Non-zero means the pool is unhealthy even if
   *  active < maxConcurrent. */
  wedged: number;
  jobTimeoutMs: number;
}

export interface WorkerPoolOptions {
  /** Wall-clock budget for one job, starting once its slot is acquired (not
   *  while queued). 0 disables the timeout — tests only; production should
   *  always bound this. */
  jobTimeoutMs?: number;
  /** Grace period after a graceful cancel before the SIGKILL fallback. */
  killGraceMs?: number;
  /** Max jobs allowed to wait for a free slot. */
  maxQueueLength?: number;
  /** Test seam: replace the real fork() with a fake worker handle. */
  spawnWorker?: () => WorkerHandle;
}

export class WorkerPool {
  private active = 0;
  private waiters: PendingSlot[] = [];
  private activeJobs = new Map<string, ActiveJob>();
  /** Jobs currently being cancelled/killed after a timeout — removed once
   *  the worker process is confirmed dead (its 'exit' event fires). */
  private killing = new Set<string>();

  readonly jobTimeoutMs: number;
  readonly killGraceMs: number;
  readonly maxQueueLength: number;
  private readonly spawnWorker: () => WorkerHandle;

  constructor(public readonly maxConcurrent: number, options: WorkerPoolOptions = {}) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
    this.spawnWorker = options.spawnWorker ?? forkWorker;
  }

  /**
   * Fork a worker, run the job, relay events to eventBus, resolve on result.
   *
   * `hooks.onSlotAcquired` fires synchronously the moment a slot is actually
   * granted — i.e. the moment the job transitions from queued to running.
   * Callers (inbox.ts) use this to flip the inbox record's status instead of
   * marking it 'running' the instant dispatch() is called, which used to
   * mislabel jobs that were still waiting behind a full pool as running.
   */
  async dispatch(
    jobId: string,
    opts: SdkRunnerOptions,
    hooks?: { onSlotAcquired?: () => void },
  ): Promise<SdkRunnerResult> {
    await this.waitForSlot();
    this.active++;
    hooks?.onSlotAcquired?.();
    try {
      return await this.runOne(jobId, opts);
    } finally {
      this.active--;
      this.activeJobs.delete(jobId);
      this.releaseSlot();
    }
  }

  /** Snapshot for /health. Never throws. */
  stats(): WorkerPoolStats {
    const now = Date.now();
    let oldestActiveMs: number | null = null;
    for (const job of this.activeJobs.values()) {
      const age = now - job.startedAt;
      if (oldestActiveMs === null || age > oldestActiveMs) oldestActiveMs = age;
    }
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.active,
      queued: this.waiters.length,
      maxQueueLength: this.maxQueueLength,
      oldestActiveMs,
      wedged: this.killing.size,
      jobTimeoutMs: this.jobTimeoutMs,
    };
  }

  private waitForSlot(): Promise<void> {
    if (this.active < this.maxConcurrent) return Promise.resolve();
    if (this.waiters.length >= this.maxQueueLength) {
      return Promise.reject(new WorkerPoolQueueFullError(this.waiters.length, this.maxQueueLength));
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private releaseSlot(): void {
    const w = this.waiters.shift();
    if (w) w.resolve();
  }

  private runOne(jobId: string, opts: SdkRunnerOptions): Promise<SdkRunnerResult> {
    return new Promise<SdkRunnerResult>((resolve, reject) => {
      this.activeJobs.set(jobId, { jobId, startedAt: Date.now() });

      const child = this.spawnWorker();

      let settled = false;
      let childExited = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;

      const clearGraceTimer = () => {
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = undefined;
        }
      };

      // Settles the dispatch() promise exactly once. Deliberately does NOT
      // touch graceTimer: when the timeout path calls this to reject the
      // caller, the pending force-kill must still run on its own schedule —
      // settling the promise and actually killing the process are separate
      // concerns (see class doc: slot release must not wait on the kill).
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        fn();
      };

      const forceKill = () => {
        // Process-tree fallback: the worker was forked detached (its own
        // process group), so signalling the negative pid reaches every
        // descendant (Playwright's browser, the `claude` CLI subprocess) —
        // not just the immediate forked process. Fall back to a plain
        // kill() if the group signal isn't available (e.g. no pid on a
        // fake test handle, or a platform where process groups don't work
        // this way).
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      };

      child.on('message', (raw: unknown) => {
        const msg = raw as { kind: string; jobId?: string; event?: unknown; result?: SdkRunnerResult; message?: string };
        if (msg.kind === 'event' && msg.event) {
          // Re-publish on the parent eventBus. The SSE streams filter by
          // event.sessionId === jobId.
          eventBus.publish(msg.event as Parameters<typeof eventBus.publish>[0]);
        } else if (msg.kind === 'result' && msg.jobId === jobId && msg.result) {
          settle(() => resolve(msg.result!));
        } else if (msg.kind === 'error' && msg.jobId === jobId) {
          settle(() => reject(new Error(msg.message ?? 'worker error')));
        }
      });

      child.on('error', (err) => settle(() => reject(err)));
      child.on('exit', (code) => {
        childExited = true;
        this.killing.delete(jobId);
        clearGraceTimer();
        settle(() => reject(new Error(`worker exited early with code ${code ?? 'null'}`)));
      });

      if (this.jobTimeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          this.killing.add(jobId);
          eventBus.send('daemon:job_timeout', { jobId, timeoutMs: this.jobTimeoutMs });
          // Graceful: ask the worker to abort its SDK query and exit cleanly.
          try { child.send({ kind: 'cancel', jobId }); } catch { /* best effort */ }
          graceTimer = setTimeout(() => {
            graceTimer = undefined;
            if (childExited) return;
            eventBus.send('daemon:job_force_killed', { jobId, killGraceMs: this.killGraceMs });
            forceKill();
          }, this.killGraceMs);
          // Reject the caller (and free the slot, via dispatch()'s finally)
          // right away — the next waiter shouldn't have to wait out the
          // kill grace period too. The graceTimer above keeps running.
          settle(() => reject(new WorkerJobTimeoutError(jobId, this.jobTimeoutMs)));
        }, this.jobTimeoutMs);
      }

      child.send({ kind: 'job', jobId, opts: serializableOpts(opts) });
    });
  }
}

/** Singleton pool for the daemon process. Reconfigured at startup. */
let poolInstance: WorkerPool | null = null;

export function configurePool(maxConcurrent: number, options?: WorkerPoolOptions): WorkerPool {
  poolInstance = new WorkerPool(maxConcurrent, options);
  return poolInstance;
}

export function getPool(): WorkerPool | null {
  return poolInstance;
}

/** Test seam: drop the singleton back to unconfigured (tests only), so a
 *  test that calls configurePool() doesn't leak a pool into unrelated tests
 *  running later in the same process. */
export function __resetPoolForTesting(): void {
  poolInstance = null;
}
