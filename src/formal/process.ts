import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ProcessResult, RunProcessOptions } from './types.js';

export const PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 200;
const activeStops = new Set<() => void>();
let forwardingSignal = false;

const forwardSignal = (signal: NodeJS.Signals): void => {
  if (forwardingSignal) return;
  forwardingSignal = true;
  for (const stop of activeStops) stop();
  const finishForwarding = (): void => {
    if (activeStops.size) {
      setTimeout(finishForwarding, KILL_GRACE_MS);
      return;
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.kill(process.pid, signal);
  };
  finishForwarding();
};
const onSigint = (): void => forwardSignal('SIGINT');
const onSigterm = (): void => forwardSignal('SIGTERM');

function registerActive(stop: () => void): void {
  if (!activeStops.size) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  activeStops.add(stop);
}

function unregisterActive(stop: () => void): void {
  activeStops.delete(stop);
  if (!activeStops.size && !forwardingSignal) {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

/** Run an executable directly, retaining bounded output and killing its process group on stop. */
export function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }

  const startedAt = performance.now();
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let exitCode: number | null = null;
    let timedOut = false;
    let unavailable = false;
    let outputLimit = false;
    let message: string | undefined;
    let stopRequested = false;
    let closeReceived = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const signalTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process group may already have exited.
        }
      } else {
        child.kill(signal);
      }
    };
    const stopForSignal = (): void => requestStop();
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      message = `process exceeded ${options.timeoutMs}ms timeout`;
      requestStop();
    }, options.timeoutMs);
    timeoutTimer.unref();

    const finish = (): void => {
      if (settled || !closeReceived || (stopRequested && killTimer)) {
        return;
      }
      settled = true;
      unregisterActive(stopForSignal);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        unavailable,
        outputLimit,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(message ? { message } : {}),
      });
    };

    const requestStop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      signalTree('SIGTERM');
      killTimer = setTimeout(() => {
        signalTree('SIGKILL');
        killTimer = undefined;
        finish();
      }, KILL_GRACE_MS);
    };

    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      if (outputLimit) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = PROCESS_OUTPUT_LIMIT_BYTES - capturedBytes;
      const size = Math.min(remaining, bytes.length);
      if (size > 0) {
        target.push(bytes.subarray(0, size));
        capturedBytes += size;
      }
      if (bytes.length > size) {
        outputLimit = true;
        requestStop();
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => collect(stderr, chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      message = error.message;
      unavailable = error.code === 'ENOENT';
      closeReceived = true;
      finish();
    });
    child.once('close', (code) => {
      exitCode = code;
      closeReceived = true;
      finish();
    });

    registerActive(stopForSignal);
  });
}

export type { ProcessResult, RunProcessOptions };
