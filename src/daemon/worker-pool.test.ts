import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  WorkerPool,
  WorkerJobTimeoutError,
  WorkerPoolQueueFullError,
} from './worker-pool.js';
import type { WorkerHandle } from './worker-pool.js';
import type { SdkRunnerOptions, SdkRunnerResult } from '../agent/sdk-runner.js';

/**
 * SP-1xd: unit tests for the fixes to worker-pool.ts —
 *   1. bounded per-job timeout (starts once a slot is acquired)
 *   2. graceful cancel + process-tree kill fallback
 *   4. health telemetry (stats(): active/queued/oldestActiveMs/wedged)
 *   6. bounded queue backpressure
 *
 * These exercise WorkerPool directly with an injected fake worker handle
 * (the `spawnWorker` test seam) instead of forking real child processes —
 * fast, deterministic, and safe (no real process-tree signals sent).
 */

const baseOpts: SdkRunnerOptions = {
  task: 'verify',
  systemPrompt: 'system',
  userPrompt: 'user',
  outputDir: '/tmp/specify-worker-pool-test',
};

/**
 * In-memory stand-in for child_process.ChildProcess. Deliberately has no
 * `pid` by default so the process-tree kill fallback in worker-pool.ts
 * falls back to a plain kill() instead of signalling a real OS process
 * group — tests must never send real signals.
 *
 * Not declared `implements WorkerHandle`: WorkerHandle's `on()` is an
 * overloaded call signature (one per event name) purely for call-site
 * ergonomics in worker-pool.ts, and a single loose implementation here
 * satisfies it structurally without needing to replicate the overloads —
 * spawnWorker() below casts to WorkerHandle at the one place it matters.
 */
class FakeWorker {
  readonly pid: number | undefined;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly killedWith: Array<NodeJS.Signals | undefined> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(pid?: number) {
    this.pid = pid;
  }

  send(msg: Record<string, unknown>): boolean {
    this.sent.push(msg);
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith.push(signal);
    return true;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  asHandle(): WorkerHandle {
    return this as unknown as WorkerHandle;
  }
}

function okResult(result: string): SdkRunnerResult {
  return { result, costUsd: 0 };
}

/** Flush pending microtasks — dispatch()/runOne() spawn the fake worker
 *  after a couple of `await`s (waitForSlot() resolving, the runOne Promise
 *  executor running), so tests need at least one tick before asserting on
 *  spawned workers. */
async function tick(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

test('dispatch() resolves with the worker result and frees the slot', async () => {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 0,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const p = pool.dispatch('job1', baseOpts);
  await tick();
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent[0], { kind: 'job', jobId: 'job1', opts: baseOpts });

  workers[0].emit('message', { kind: 'result', jobId: 'job1', result: okResult('ok') });
  const result = await p;
  assert.equal(result.result, 'ok');

  const stats = pool.stats();
  assert.equal(stats.active, 0);
  assert.equal(stats.oldestActiveMs, null);
  assert.equal(stats.wedged, 0);
});

test('dispatch() rejects when the worker reports an error, and frees its slot', async () => {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 0,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const p = pool.dispatch('job1', baseOpts);
  await tick();
  const rejection = assert.rejects(p, /boom/);
  workers[0].emit('message', { kind: 'error', jobId: 'job1', message: 'boom' });
  await rejection;
  assert.equal(pool.stats().active, 0, 'the slot must be freed after an error result too');
});

test('a second job queues behind a saturated pool and only acquires its slot once freed', async () => {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 0,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const pA = pool.dispatch('A', baseOpts);
  await tick();
  assert.equal(workers.length, 1, 'A should spawn immediately (free slot)');

  let bAcquired = false;
  const pB = pool.dispatch('B', baseOpts, { onSlotAcquired: () => { bAcquired = true; } });
  await tick();

  assert.equal(bAcquired, false, 'B must not acquire a slot while A holds the only one');
  assert.equal(workers.length, 1, 'B must not spawn a worker while queued');
  assert.equal(pool.stats().queued, 1);
  assert.equal(pool.stats().active, 1);

  workers[0].emit('message', { kind: 'result', jobId: 'A', result: okResult('a') });
  await pA;
  await tick();

  assert.equal(bAcquired, true, 'B should acquire its slot as soon as A releases');
  assert.equal(workers.length, 2, 'B should spawn its own worker once granted a slot');
  assert.equal(pool.stats().queued, 0);

  workers[1].emit('message', { kind: 'result', jobId: 'B', result: okResult('b') });
  await pB;
});

test('a stalled job times out, releases its slot immediately for the next waiter', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 1000,
    killGraceMs: 500,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const pStalled = pool.dispatch('stalled', baseOpts);
  await tick();
  assert.equal(workers.length, 1);

  let stalledError: unknown;
  pStalled.catch((e) => { stalledError = e; });

  // A second job queues right behind the stalled one.
  let secondAcquired = false;
  const pSecond = pool.dispatch('second', baseOpts, { onSlotAcquired: () => { secondAcquired = true; } });
  await tick();
  assert.equal(pool.stats().queued, 1);

  // Advance past the per-job timeout.
  t.mock.timers.tick(1000);
  await tick(4);

  assert.ok(stalledError instanceof WorkerJobTimeoutError, 'stalled job should reject with a timeout error');
  assert.equal(pool.stats().active, 1, 'the freed slot should already be handed to the next waiter');
  assert.equal(secondAcquired, true, 'the next waiter should run as soon as the timeout frees the slot');
  assert.equal(pool.stats().wedged, 1, 'the timed-out job should still show up as wedged until confirmed dead');

  const cancelMsg = workers[0].sent.find((m) => m.kind === 'cancel');
  assert.deepEqual(cancelMsg, { kind: 'cancel', jobId: 'stalled' }, 'timeout should send a graceful cancel first');
  assert.equal(workers[0].killedWith.length, 0, 'must not force-kill before the grace period elapses');

  // Let the second job finish so its promise doesn't dangle.
  assert.equal(workers.length, 2);
  workers[1].emit('message', { kind: 'result', jobId: 'second', result: okResult('ok') });
  await pSecond;
});

test('a job that never exits after a graceful cancel is force-killed once the grace period elapses', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 1000,
    killGraceMs: 500,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const p = pool.dispatch('stalled', baseOpts);
  await tick();
  p.catch(() => { /* expected timeout rejection, asserted below via stats */ });

  t.mock.timers.tick(1000); // fires the job timeout -> sends cancel, arms grace timer
  await tick(4);
  assert.equal(workers[0].killedWith.length, 0);

  t.mock.timers.tick(500); // grace period elapses without the worker exiting
  await tick(4);

  assert.equal(workers[0].killedWith[0], 'SIGKILL', 'must force-kill after the grace period if the worker never exited');
  assert.equal(pool.stats().wedged, 1, 'still wedged until the OS actually reaps the process');

  // Simulate the OS finally reporting the killed worker as exited.
  workers[0].emit('exit', null, 'SIGKILL');
  assert.equal(pool.stats().wedged, 0, 'wedged count clears once the worker is confirmed dead');
});

test('a worker that exits gracefully after cancel is not force-killed', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 1000,
    killGraceMs: 500,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const p = pool.dispatch('stalled', baseOpts);
  await tick();
  p.catch(() => { /* expected */ });

  t.mock.timers.tick(1000);
  await tick(4);

  // Worker honors the graceful cancel and exits cleanly before the grace
  // period is up.
  workers[0].emit('exit', 0, null);
  assert.equal(pool.stats().wedged, 0, 'a clean exit before the grace deadline should clear wedged immediately');

  t.mock.timers.tick(500);
  await tick(2);
  assert.equal(workers[0].killedWith.length, 0, 'must not force-kill a worker that already exited gracefully');
});

test('dispatch() rejects immediately once the wait queue is full, without spawning a worker', async () => {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 0,
    maxQueueLength: 1,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  const pA = pool.dispatch('A', baseOpts);
  await tick();
  const pB = pool.dispatch('B', baseOpts); // fills the one queue slot
  await tick();
  assert.equal(pool.stats().queued, 1);

  await assert.rejects(pool.dispatch('C', baseOpts), WorkerPoolQueueFullError);
  assert.equal(workers.length, 1, 'C must never spawn a worker — it was shed at the queue bound');
  assert.equal(pool.stats().queued, 1, 'the queue bound must not have grown to admit C');

  workers[0].emit('message', { kind: 'result', jobId: 'A', result: okResult('a') });
  await pA;
  await tick();
  assert.equal(workers.length, 2);
  workers[1].emit('message', { kind: 'result', jobId: 'B', result: okResult('b') });
  await pB;
});

test('stats() reports growing oldestActiveMs while a job is in flight', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(1, {
    jobTimeoutMs: 0,
    spawnWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w.asHandle();
    },
  });

  assert.equal(pool.stats().oldestActiveMs, null, 'idle pool has no active job age');
  const p = pool.dispatch('job1', baseOpts);
  await tick();
  assert.equal(pool.stats().active, 1);
  assert.equal(pool.stats().maxConcurrent, 1);

  workers[0].emit('message', { kind: 'result', jobId: 'job1', result: okResult('ok') });
  await p;
  assert.equal(pool.stats().oldestActiveMs, null, 'completed job should no longer count toward active age');
});
