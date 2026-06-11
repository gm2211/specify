/**
 * src/daemon/worker.ts — Forked worker process for the daemon's stateless pool.
 *
 * One job per fork: receive job over IPC, run `runSpecifyAgent`, stream agent
 * events back to the parent over IPC, send a final result or error, exit.
 *
 * Kept deliberately thin: the only runtime state is the current job. Anything
 * cross-job (queue, session keys, history) lives in the parent.
 *
 * Parent → worker messages:
 *   { kind: 'job', jobId: string, opts: SdkRunnerOptions }
 *
 * Worker → parent messages:
 *   { kind: 'event',  jobId, event: SpecifyEvent }
 *   { kind: 'result', jobId, result: SdkRunnerResult }
 *   { kind: 'error',  jobId, message: string }
 */

import { eventBus } from '../agent/event-bus.js';
import { runSpecifyAgent } from '../agent/sdk-runner.js';
import type { SdkRunnerOptions } from '../agent/sdk-runner.js';

// Defense-in-depth: swallow EPIPE at the process level so a stdio write fault
// (e.g. parent exits before the worker finishes flushing IPC messages) doesn't
// crash the worker and obscure the real job result.  Any non-EPIPE exception is
// re-thrown on the next tick so Node's default handler still surfaces it.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    // Write directly to fd 2 — process.stderr.write itself could EPIPE.
    try {
      if (process.stderr.fd !== undefined) {
        (require as NodeRequire)('fs').writeSync(process.stderr.fd, '[worker] swallowed EPIPE — continuing\n');
      }
    } catch { /* best-effort log */ }
    return;
  }
  // Re-throw on next tick so Node's unhandled-exception mechanism sees it.
  setImmediate(() => { throw err; });
});

function send(msg: Record<string, unknown>): void {
  if (process.send) process.send(msg);
}

// Pipe every event from this process's eventBus back to the parent so the
// parent can re-emit them on its bus. The SSE stream on the HTTP side then
// filters by the event's sessionId (which is the inbox message id).
eventBus.onAny((event) => send({ kind: 'event', event }));

process.on('message', async (raw: unknown) => {
  const msg = raw as { kind: string; jobId?: string; opts?: SdkRunnerOptions };
  if (msg.kind !== 'job' || !msg.jobId || !msg.opts) return;

  const { jobId, opts } = msg;
  try {
    const result = await runSpecifyAgent(opts);
    send({ kind: 'result', jobId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: 'error', jobId, message });
  } finally {
    // One job per worker — let the parent see the clean exit.
    setImmediate(() => process.exit(0));
  }
});

// If the parent disconnects before we finish, bail rather than stay orphaned.
process.on('disconnect', () => {
  process.exit(0);
});
