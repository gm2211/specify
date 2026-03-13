/**
 * src/cli-test/executor.ts — Execute CLI commands and capture output
 */

import { spawn } from 'child_process';
import type { CliCommandSpec, CliSpec } from '../spec/types.js';
import type { CliCommandRun } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Execute a single CLI command and capture its output. */
export async function executeCommand(
  cmd: CliCommandSpec,
  cliSpec: CliSpec,
  log?: (msg: string) => void,
): Promise<CliCommandRun> {
  const timeout = cmd.timeout_ms ?? cliSpec.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, ...cliSpec.env, ...cmd.env };

  // Split binary into command + initial args
  const binaryParts = cliSpec.binary.split(/\s+/);
  const command = binaryParts[0];
  const allArgs = [...binaryParts.slice(1), ...cmd.args];

  log?.(`  Running: ${cliSpec.binary} ${cmd.args.join(' ')}`);

  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  return new Promise<CliCommandRun>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const child = spawn(command, allArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // Pipe stdin if provided
    if (cmd.stdin) {
      child.stdin.write(cmd.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      log?.(`  Exit ${exitCode} (${durationMs}ms)${timedOut ? ' [TIMEOUT]' : ''}`);

      resolve({
        id: cmd.id,
        args: cmd.args,
        exitCode,
        stdout,
        stderr,
        durationMs,
        timestamp,
        timedOut,
      });
    };

    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        id: cmd.id,
        args: cmd.args,
        exitCode: 127,
        stdout: '',
        stderr: `Failed to spawn: ${err.message}`,
        durationMs: Date.now() - startTime,
        timestamp,
        timedOut: false,
      });
    });
  });
}
