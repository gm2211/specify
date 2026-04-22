/**
 * src/daemon/worker-pool.ts — Fork-per-job dispatcher for stateless inbox runs.
 *
 * The parent process owns the inbox queue + HTTP server. When a stateless
 * message is dispatched, we:
 *
 *   1. Wait for a free slot (up to maxConcurrent jobs in flight).
 *   2. `child_process.fork` a worker running src/daemon/worker.js.
 *   3. Send it the job over IPC.
 *   4. Relay the worker's `event` messages onto our own eventBus so the SSE
 *      stream sees them; resolve with the worker's `result` message.
 *
 * Attach-mode sessions keep their SDK query in-process (serial by design), so
 * they bypass the pool entirely.
 */

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
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

interface PendingSlot {
  resolve: () => void;
}

/** Functions in SdkRunnerOptions cannot cross IPC — strip them before sending. */
function serializableOpts(opts: SdkRunnerOptions): SdkRunnerOptions {
  const { onBehaviorProgress: _1, askUserHandler: _2, messageInjector: _3, ...rest } = opts;
  return rest as SdkRunnerOptions;
}

export class WorkerPool {
  private active = 0;
  private waiters: PendingSlot[] = [];

  constructor(public readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
  }

  /** Fork a worker, run the job, relay events to eventBus, resolve on result. */
  async dispatch(jobId: string, opts: SdkRunnerOptions): Promise<SdkRunnerResult> {
    await this.waitForSlot();
    this.active++;
    try {
      return await this.runOne(jobId, opts);
    } finally {
      this.active--;
      this.releaseSlot();
    }
  }

  private waitForSlot(): Promise<void> {
    if (this.active < this.maxConcurrent) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  private releaseSlot(): void {
    const w = this.waiters.shift();
    if (w) w.resolve();
  }

  private runOne(jobId: string, opts: SdkRunnerOptions): Promise<SdkRunnerResult> {
    return new Promise<SdkRunnerResult>((resolve, reject) => {
      const workerPath = resolveWorkerPath();
      const child: ChildProcess = fork(workerPath, [], {
        // Keep stderr visible so users can still see Playwright / SDK logs.
        // Workers prefix nothing; parent stderr will interleave — acceptable
        // because primary telemetry is the event bus, tagged by jobId.
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });

      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
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
        settle(() => reject(new Error(`worker exited early with code ${code ?? 'null'}`)));
      });

      child.send({ kind: 'job', jobId, opts: serializableOpts(opts) });
    });
  }
}

/** Singleton pool for the daemon process. Reconfigured at startup. */
let poolInstance: WorkerPool | null = null;

export function configurePool(maxConcurrent: number): WorkerPool {
  poolInstance = new WorkerPool(maxConcurrent);
  return poolInstance;
}

export function getPool(): WorkerPool | null {
  return poolInstance;
}
