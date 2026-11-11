import fs from 'node:fs';
import { runGate, writeLock } from '../../formal/gate.js';
import { formatGate } from '../../formal/report.js';
import { exportTraces } from '../../formal/trace.js';
import { ExitCode } from '../exit-codes.js';
import { writeOutput } from '../output.js';
import type { CliContext } from '../types.js';

export interface GateCliOptions {
  root?: string;
  timeoutMs?: string;
  quintBin?: string;
  leanBin?: string;
  tool?: string;
  policy?: string;
  base?: string;
  testReport?: string;
  hook?: string;
  changed?: boolean;
  skipVerify?: boolean;
}

function integer(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}

/** A Stop hook that already blocked once must let the agent stop, or it would loop forever. */
function stopHookAlreadyActive(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8')) as { stop_hook_active?: unknown };
    return input.stop_hook_active === true;
  } catch {
    return false;
  }
}

export async function gate(options: GateCliOptions, ctx: CliContext): Promise<number> {
  if (options.tool !== undefined && options.tool !== 'quint' && options.tool !== 'lean') {
    throw new Error('--tool must be quint or lean');
  }
  if (options.policy !== undefined && options.policy !== 'strict' && options.policy !== 'warn') {
    throw new Error('--policy must be strict or warn');
  }
  if (options.hook !== undefined && options.hook !== 'stop' && options.hook !== 'pre-push') {
    throw new Error('--hook must be stop or pre-push');
  }
  if (options.base !== undefined && !/^[\w./@^~-]+$/.test(options.base)) {
    throw new Error('--base must be a git ref');
  }
  if (options.hook === 'stop' && stopHookAlreadyActive()) return ExitCode.SUCCESS;

  const summary = await runGate({
    root: options.root ?? '.',
    timeoutMs: integer(options.timeoutMs, 60_000, '--timeout-ms', 600_000),
    quintBin: options.quintBin,
    leanBin: options.leanBin,
    tool: options.tool,
    policy: options.policy,
    base: options.base,
    changed: options.changed,
    skipVerify: options.skipVerify,
    testReports: options.testReport?.split(',').filter(Boolean),
    tolerateUnavailable: options.hook !== undefined,
  });
  if (options.hook) {
    // Hooks read stderr: Claude Code feeds it back to the agent when the exit code is 2.
    if (summary.valid) return ExitCode.SUCCESS;
    process.stderr.write(
      `${formatGate(summary)}\n\nFix the failures above, then finish. Do not weaken a property, flip expect, or remove a link to pass.\n`,
    );
    return options.hook === 'stop' ? ExitCode.HOOK_BLOCKED : ExitCode.CHECKS_NOT_AS_EXPECTED;
  }
  const human = ctx.outputFormat === 'text' || ctx.outputFormat === 'markdown';
  writeOutput(human && !ctx.fields ? formatGate(summary) : summary, ctx);
  return summary.valid ? ExitCode.SUCCESS : ExitCode.CHECKS_NOT_AS_EXPECTED;
}

export function lock(options: { root?: string }, ctx: CliContext): number {
  writeOutput(writeLock(options.root ?? '.'), ctx);
  return ExitCode.SUCCESS;
}

export interface TraceExportCliOptions {
  root?: string;
  out?: string;
  traces?: string;
  maxSteps?: string;
  seed?: string;
  quintBin?: string;
}

export async function traceExport(
  options: TraceExportCliOptions,
  ctx: CliContext,
): Promise<number> {
  if (options.seed !== undefined && !/^\d+$/.test(options.seed)) {
    throw new Error('--seed must be a nonnegative integer');
  }
  const exported = await exportTraces({
    root: options.root ?? '.',
    out: options.out,
    traces: integer(options.traces, 10, '--traces', 1000),
    maxSteps: integer(options.maxSteps, 20, '--max-steps', 10_000),
    seed: options.seed === undefined ? 1 : Number(options.seed),
    quintBin: options.quintBin,
  });
  writeOutput({ models: exported }, ctx);
  return exported.length && exported.every((entry) => !entry.error)
    ? ExitCode.SUCCESS
    : ExitCode.CHECKS_NOT_AS_EXPECTED;
}
