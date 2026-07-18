/**
 * src/model/quint-runner.ts — Injectable boundary over the `quint` CLI (SP-i35).
 *
 * `quint run <spec.qnt> --out-itf <file>` performs RANDOM SIMULATION of a Quint
 * spec and writes an ITF trace (src/model/quint-itf.ts). That random simulator
 * is pure npm (`@informalsystems/quint`) and is the DEFAULT trace generator here
 * — no JVM required. The symbolic checker backend (Apalache) needs a Java
 * runtime and is a separate, heavier opt-in: `runSymbolic` is refused unless the
 * caller explicitly asks for it AND `quintSymbolicBackendEnabled()` is set. This
 * module keeps the whole toolchain OFF the default path: nothing here runs
 * unless a caller behind `quintSpecsEnabled()` invokes it.
 *
 * INSTALLATION IS THE OPERATOR'S OPT-IN, NOT A HARD DEPENDENCY
 * ----------------------------------------------------------------------------
 * `@informalsystems/quint` is deliberately NOT a package.json dependency: a P4
 * opt-in for a handful of teams should not pull a large toolchain into every
 * install (the epic's whole thesis is that dual-artifact maintenance is a cost
 * to avoid by default). A team that flips `SPECIFY_ENABLE_QUINT_SPECS` installs
 * the CLI themselves (`npm i -g @informalsystems/quint`, or a project-local dev
 * dependency), and `binary`/PATH resolution finds it. If it is absent, the
 * runner reports a structured "could not run quint" error rather than crashing —
 * so a missing toolchain degrades gracefully to "no Quint traces this run".
 *
 * THE CLI IS AN INJECTABLE SEAM
 * ----------------------------------------------------------------------------
 * The actual subprocess spawn lives behind a `QuintExec` function so tests never
 * need `quint` installed — they inject a fake exec that returns canned
 * stdout/stderr/exit, exactly the way the executor's `StepDriver` is faked
 * (src/agent/trace-executor.ts). The default exec (`spawnQuint`) shells out via
 * `child_process.spawn` with an argv array (NEVER a shell string), mirroring the
 * CLI target channel (src/agent/cli-mcp.ts), and never throws — a spawn error
 * (e.g. `quint` not on PATH) resolves to a non-zero result the runner turns into
 * a structured error, so a missing toolchain is a reported condition, not a
 * crash.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseItfJson, type ItfTrace } from './quint-itf.js';
import { quintSymbolicBackendEnabled } from '../agent/feature-flags.js';

// ---------------------------------------------------------------------------
// Exec seam
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout crossed the per-stream cap and was truncated. */
  stdoutTruncated?: boolean;
  /** True when stderr crossed the per-stream cap and was truncated. */
  stderrTruncated?: boolean;
  /** Present when the process could not be spawned at all (e.g. binary missing). */
  spawnError?: string;
}

/** The subprocess boundary. Injected in tests; defaults to a real `spawn`. */
export type QuintExec = (argv: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<ExecResult>;

/**
 * Per-stream output cap: 256 KiB, matching src/agent/cli-mcp.ts's
 * OUTPUT_CAP_BYTES. quint's stdout/stderr are diagnostics only (the real
 * output is the `--out-itf` file), so a chatty or looping process must not be
 * able to balloon memory before its timeout fires.
 */
export const QUINT_OUTPUT_CAP_BYTES = 256 * 1024;

/**
 * Bounded accumulator for a child process stream (the BoundedSink pattern from
 * src/agent/cli-mcp.ts): appends only up to `capBytes`, then flips `truncated`
 * and drops everything past the cap. The stream keeps flowing — exit-code
 * collection is unaffected; we just stop storing.
 */
class BoundedSink {
  text = '';
  truncated = false;
  constructor(private readonly capBytes: number) {}

  append(chunk: Buffer | string): void {
    if (this.truncated) return;
    const s = chunk.toString();
    const remaining = this.capBytes - this.text.length;
    if (s.length <= remaining) {
      this.text += s;
    } else {
      this.text += s.slice(0, remaining);
      this.truncated = true;
    }
  }
}

/** Default exec: spawn `quint …` with an argv array (no shell). Never throws. */
export const spawnQuint: QuintExec = (argv, opts) =>
  new Promise<ExecResult>((resolve) => {
    const stdout = new BoundedSink(QUINT_OUTPUT_CAP_BYTES);
    const stderr = new BoundedSink(QUINT_OUTPUT_CAP_BYTES);
    let settled = false;
    const snapshot = (): Pick<ExecResult, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'> => ({
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    });
    const finish = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ code: null, ...snapshot(), spawnError: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, ...snapshot(), spawnError: `quint timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout.append(d);
    });
    child.stderr?.on('data', (d) => {
      stderr.append(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: null, ...snapshot(), spawnError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, ...snapshot() });
    });
  });

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface QuintRunOptions {
  /** Path to the `.qnt` spec file to simulate. */
  specPath: string;
  /** Max transitions per simulated trace. Default 20. */
  maxSteps?: number;
  /** Number of simulation samples to draw. Default 1. */
  maxSamples?: number;
  /** Seed for reproducible random simulation. Optional (quint picks one if absent). */
  seed?: number;
  /** The invariant/temporal property to check while simulating (quint `--invariant`). Optional. */
  invariant?: string;
  /** Request the JVM symbolic backend instead of random simulation. Gated OFF by default. */
  symbolic?: boolean;
  /** The quint binary. Default 'quint' (resolved on PATH). */
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Injected subprocess boundary. Default {@link spawnQuint}. */
  exec?: QuintExec;
}

export interface QuintRunResult {
  ok: boolean;
  /** The ITF traces parsed from quint's `--out-itf` output (empty on failure). */
  traces: ItfTrace[];
  /** Non-fatal ITF decode problems, aggregated across traces. */
  itfErrors: string[];
  /** Fatal error (spawn failure, non-zero exit, symbolic-requested-but-gated, no output). */
  error?: string;
  /** The exact argv the runner invoked, for reproducibility/debugging. */
  argv: string[];
  /** quint's raw stderr tail, surfaced on failure. */
  stderr?: string;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Validate `options.binary`. PATH resolution of a bare command name is
 * INTENTIONAL here — the toolchain is operator-installed (see the module doc),
 * so "quint on PATH" is the expected default and an absolute path is the
 * explicit override. What is NOT accepted is anything shell-shaped: whitespace,
 * quoting, or metacharacters. We never invoke a shell (argv-array spawn), so a
 * composite string like "quint --evil" would misresolve rather than inject —
 * but rejecting it up front turns a confusing ENOENT into a clear config error.
 * Kept permissive enough for tests to inject an absolute node binary path.
 */
export function isValidQuintBinary(binary: string): boolean {
  if (binary.length === 0) return false;
  // No whitespace or shell metacharacters anywhere.
  if (/[\s;&|<>$`"'\\!*?(){}[\]#~\n\r]/.test(binary)) return false;
  // A bare command name (resolved on PATH) or an absolute path.
  return !binary.includes('/') || binary.startsWith('/');
}

/**
 * Simulate a Quint spec and return the ITF traces it produced. Never throws.
 * Writes the ITF to a temp file, invokes quint, reads it back, and parses it
 * with the tolerant ITF parser. A symbolic request is refused unless the caller
 * asked for it AND the JVM backend flag is on — the refusal is a structured
 * error, not a silent downgrade.
 */
export async function runQuintSimulation(options: QuintRunOptions): Promise<QuintRunResult> {
  const exec = options.exec ?? spawnQuint;
  const binary = options.binary ?? 'quint';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!isValidQuintBinary(binary)) {
    return {
      ok: false,
      traces: [],
      itfErrors: [],
      error: `invalid quint binary "${binary}" — expected a bare command name (resolved on PATH) or an absolute path, with no whitespace or shell metacharacters`,
      argv: [],
    };
  }

  if (options.symbolic && !quintSymbolicBackendEnabled()) {
    return {
      ok: false,
      traces: [],
      itfErrors: [],
      error:
        'symbolic backend requested but SPECIFY_ENABLE_QUINT_SYMBOLIC is not set — the JVM/Apalache backend is opt-in; the default is `quint run` random simulation',
      argv: [],
    };
  }

  const outFile = path.join(
    os.tmpdir(),
    `specify-quint-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.itf.json`,
  );

  const verb = options.symbolic ? 'verify' : 'run';
  const argv: string[] = [binary, verb, '--out-itf', outFile, '--max-steps', String(options.maxSteps ?? DEFAULT_MAX_STEPS)];
  if (!options.symbolic) {
    argv.push('--max-samples', String(options.maxSamples ?? 1));
  }
  if (options.seed !== undefined) argv.push('--seed', String(options.seed));
  if (options.invariant) argv.push('--invariant', options.invariant);
  argv.push(options.specPath);

  let result: ExecResult;
  try {
    result = await exec(argv, { cwd: options.cwd, timeoutMs });
  } catch (err) {
    // A well-behaved QuintExec never throws; guard defensively anyway.
    safeUnlink(outFile);
    return { ok: false, traces: [], itfErrors: [], error: `quint exec threw: ${(err as Error).message}`, argv };
  }

  if (result.spawnError) {
    safeUnlink(outFile);
    return { ok: false, traces: [], itfErrors: [], error: `could not run quint: ${result.spawnError}`, argv, stderr: result.stderr };
  }

  // quint exits non-zero when an invariant is VIOLATED — that still writes an
  // ITF counterexample, which is exactly the trace we want to execute. So a
  // non-zero exit is only fatal when no ITF file was produced.
  let itfText: string | undefined;
  try {
    itfText = fs.readFileSync(outFile, 'utf-8');
  } catch {
    itfText = undefined;
  }
  safeUnlink(outFile);

  if (itfText === undefined) {
    return {
      ok: false,
      traces: [],
      itfErrors: [],
      error: `quint produced no ITF output (exit ${result.code ?? 'null'})`,
      argv,
      stderr: result.stderr,
    };
  }

  const parsed = parseItfJson(itfText);
  return {
    ok: parsed.trace.states.length > 0,
    traces: parsed.trace.states.length > 0 ? [parsed.trace] : [],
    itfErrors: parsed.errors,
    ...(parsed.trace.states.length === 0 ? { error: 'ITF output contained no states' } : {}),
    argv,
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // best-effort cleanup
  }
}
