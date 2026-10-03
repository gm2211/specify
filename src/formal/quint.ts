import net from 'node:net';
import type { QuintFormalCheck } from '../spec/types.js';
import { runProcess } from './process.js';
import type { FormalOutcome, FormalScope, ProcessResult, RunProcessOptions } from './types.js';

const SUCCESS_MARKER = '[ok] No violation found';
const COUNTEREXAMPLE_MARKERS = ['[violation] Found an issue', 'error: found a counterexample'];

export interface QuintRunnerOptions {
  executable: string;
  cwd: string;
  timeoutMs: number;
  run?: typeof runProcess;
  allocatePort?: () => Promise<number>;
}

export function classifyQuintResult(
  result: ProcessResult,
  evidence: 'simulation' | 'bounded-model-check',
  scope: FormalScope,
  property: string,
): FormalOutcome {
  const output = `${result.stdout}\n${result.stderr}`;
  const common = {
    evidence,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    statement: property,
    scope,
  } as const;

  if (result.unavailable) {
    return {
      ...common,
      status: 'unavailable',
      message: result.message ?? 'Quint executable is unavailable',
    };
  }
  if (result.outputLimit) {
    return { ...common, status: 'error', message: 'Quint output exceeded the 1 MiB limit' };
  }
  if (result.timedOut) {
    return { ...common, status: 'timeout', message: result.message ?? 'Quint check timed out' };
  }
  const reportsSuccess = output.includes(SUCCESS_MARKER);
  const reportsCounterexample = COUNTEREXAMPLE_MARKERS.some((marker) => output.includes(marker));
  if (reportsSuccess && reportsCounterexample) {
    return {
      ...common,
      status: 'error',
      message: 'Quint emitted contradictory success and counterexample markers',
    };
  }
  if (result.exitCode === 0 && reportsSuccess) {
    return { ...common, status: 'passed' };
  }
  if (result.exitCode !== 0 && reportsCounterexample) {
    return { ...common, status: 'failed', message: `Quint found a counterexample for ${property}` };
  }
  return {
    ...common,
    status: 'error',
    message: result.message ?? `Quint returned an unrecognized result for ${property}`,
  };
}

export async function checkQuint(
  ref: QuintFormalCheck,
  file: string,
  options: QuintRunnerOptions,
): Promise<FormalOutcome> {
  const evidence = ref.mode === 'simulate' ? 'simulation' : 'bounded-model-check';
  const backend = ref.mode === 'simulate' ? 'typescript' : 'apalache';
  const scope: FormalScope = {
    mode: ref.mode,
    backend,
    maxSteps: ref.maxSteps,
    ...(ref.mode === 'simulate' ? { samples: ref.samples, seed: ref.seed } : {}),
  };
  const args = [ref.mode === 'simulate' ? 'run' : 'verify', file];
  args.push('--backend', backend, '--invariant', ref.property, '--max-steps', String(ref.maxSteps));
  args.push('--verbosity', '3');
  if (ref.main) args.push('--main', ref.main);

  if (ref.mode === 'simulate') {
    args.push('--max-samples', String(ref.samples), '--seed', String(ref.seed));
  } else {
    try {
      const port = await (options.allocatePort ?? allocateLoopbackPort)();
      args.push('--server-endpoint', `127.0.0.1:${port}`);
    } catch (error) {
      return {
        status: 'error',
        evidence,
        stdout: '',
        stderr: '',
        durationMs: 0,
        exitCode: null,
        statement: ref.property,
        scope,
        message: `Could not allocate a local Apalache endpoint: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const run = options.run ?? runProcess;
  const runOptions: RunProcessOptions = { cwd: options.cwd, timeoutMs: options.timeoutMs };
  const result = await run(options.executable, args, runOptions);
  return classifyQuintResult(result, evidence, scope, ref.property);
}

async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('TCP server did not report an allocated port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
