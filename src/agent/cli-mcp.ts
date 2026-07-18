/**
 * src/agent/cli-mcp.ts — In-process MCP server wrapping child_process for CLI targets
 *
 * Exposes a single `cli_run` tool to the Agent SDK via createSdkMcpServer.
 * This is the deterministic-capture counterpart of browser-mcp.ts for
 * target.type === 'cli' specs: every invocation is executed via
 * child_process.spawn (argv array — NEVER a shell string) and recorded into
 * a CliObservationRecorder trace, so 'command_output' evidence stops being
 * agent-pasted text and becomes a runner-recorded fact.
 *
 * Binary policy: by default argv[0] must equal the spec's target.binary —
 * the agent can pass whatever flags/args it wants, but cannot pivot to an
 * arbitrary binary through this channel. Set
 * SPECIFY_CLI_ALLOW_ANY_BINARY=1 to lift that restriction (e.g. for specs
 * that legitimately need to shell out to helper tools).
 */

import { spawn } from 'node:child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CliObservationRecorder } from './observation.js';
import { capOutput } from './observation.js';

/** Per-stream output cap: 256 KiB. Beyond this, stdout/stderr are truncated with a flag. */
const OUTPUT_CAP_BYTES = 256 * 1024;
/** Cap on the recorded (not executed) stdin length, same bound as output. */
const STDIN_CAP_BYTES = 256 * 1024;
/** Default timeout for a single cli_run invocation when neither the call nor the spec sets one. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CliMcpServerOptions {
  /** The spec's target.binary — argv[0] must match this unless the escape hatch env var is set. */
  binary: string;
  /** Environment variables from the spec's target.env, merged under process.env. */
  env?: Record<string, string>;
  /** Default timeout in ms from the spec's target.timeout_ms. */
  timeoutMs?: number;
  /** Default cwd for invocations; defaults to process.cwd() if unset. */
  cwd?: string;
  recorder: CliObservationRecorder;
  serverName?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  error?: string;
}

/** Spawn argv via child_process.spawn (no shell), collecting stdout/stderr/exit up to a timeout. */
function runProcess(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child?.kill('SIGKILL');
      } catch {
        // best-effort
      }
      finish({ stdout, stderr, exitCode: null, signal: 'SIGKILL', error: `timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: '', exitCode: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      finish({ stdout, stderr, exitCode: null, error: err.message });
    });

    child.on('close', (code, signal) => {
      finish({ stdout, stderr, exitCode: code, ...(signal ? { signal } : {}) });
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

/** True if the binary policy allows running `requested` given the spec's declared `binary`. */
export function binaryAllowed(requested: string, specBinary: string): boolean {
  if (requested === specBinary) return true;
  return process.env.SPECIFY_CLI_ALLOW_ANY_BINARY === '1' || process.env.SPECIFY_CLI_ALLOW_ANY_BINARY === 'true';
}

export function createCliMcpServer(options: CliMcpServerOptions) {
  const serverName = options.serverName ?? 'cli';
  const defaultCwd = options.cwd ?? process.cwd();
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const server = createSdkMcpServer({
    name: serverName,
    tools: [
      tool(
        'cli_run',
        `Execute a command against the CLI target. argv[0] must be "${options.binary}" ` +
          `(the spec's declared binary) unless the operator has explicitly relaxed that policy. ` +
          `Every invocation is recorded — stdout, stderr, exit code, and timing — into the ` +
          `runner's ground-truth observation trace. This is the ONLY way to execute commands ` +
          `in this session; Bash is unavailable.`,
        {
          argv: z.array(z.string()).min(1).describe('Full argv, e.g. ["mycli", "--flag", "value"]. argv[0] must be the target binary.'),
          stdin: z.string().optional().describe('Text to send to the process stdin, if any.'),
          timeoutMs: z.number().optional().describe('Timeout in milliseconds. Defaults to the spec target.timeout_ms or 30000.'),
          cwd: z.string().optional().describe('Working directory. Defaults to the runner cwd.'),
        },
        async (args) => {
          const tsStart = Date.now();
          const argv = args.argv;
          const cwd = args.cwd ?? defaultCwd;
          const timeoutMs = args.timeoutMs ?? defaultTimeout;

          if (!binaryAllowed(argv[0], options.binary)) {
            const tsEnd = Date.now();
            const errorMsg = `argv[0] "${argv[0]}" does not match the spec's target binary "${options.binary}". ` +
              `Set SPECIFY_CLI_ALLOW_ANY_BINARY=1 to allow other binaries.`;
            options.recorder.record({
              argv,
              ...(args.stdin !== undefined ? capStdin(args.stdin) : {}),
              stdout: '',
              stdoutTruncated: false,
              stderr: '',
              stderrTruncated: false,
              exitCode: null,
              cwd,
              tsStart,
              tsEnd,
              durationMs: tsEnd - tsStart,
              error: errorMsg,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMsg }) }], isError: true };
          }

          const env = { ...process.env, ...options.env };
          const result = await runProcess(argv, { cwd, env, timeoutMs, stdin: args.stdin });
          const tsEnd = Date.now();

          const cappedStdout = capOutput(result.stdout, OUTPUT_CAP_BYTES);
          const cappedStderr = capOutput(result.stderr, OUTPUT_CAP_BYTES);

          const observation = options.recorder.record({
            argv,
            ...(args.stdin !== undefined ? capStdin(args.stdin) : {}),
            stdout: cappedStdout.text,
            stdoutTruncated: cappedStdout.truncated,
            stderr: cappedStderr.text,
            stderrTruncated: cappedStderr.truncated,
            exitCode: result.exitCode,
            ...(result.signal ? { signal: result.signal } : {}),
            cwd,
            tsStart,
            tsEnd,
            durationMs: tsEnd - tsStart,
            ...(result.error ? { error: result.error } : {}),
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                step: observation.step,
                exitCode: observation.exitCode,
                signal: observation.signal,
                stdout: observation.stdout,
                stdoutTruncated: observation.stdoutTruncated,
                stderr: observation.stderr,
                stderrTruncated: observation.stderrTruncated,
                durationMs: observation.durationMs,
                error: observation.error,
              }),
            }],
          };
        },
      ),
    ],
  });

  return server;
}

function capStdin(stdin: string): { stdin: string; stdinTruncated?: boolean } {
  const capped = capOutput(stdin, STDIN_CAP_BYTES);
  return capped.truncated ? { stdin: capped.text, stdinTruncated: true } : { stdin: capped.text };
}

export function cliToolNames(serverName: string = 'cli'): string[] {
  return [`mcp__${serverName}__cli_run`];
}
