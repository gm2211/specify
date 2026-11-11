import net from 'node:net';
import { runProcess } from './process.js';
import { extractCounterexample } from './trace.js';
import type {
  FormalEvidence,
  FormalOutcome,
  FormalScope,
  ProcessResult,
  QuintFormalCheck,
  RunProcessOptions,
} from './types.js';

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
  evidence: FormalEvidence,
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
    return { ...common, status: 'holds' };
  }
  if (result.exitCode !== 0 && reportsCounterexample) {
    const trace = extractCounterexample(output);
    return {
      ...common,
      status: 'fails',
      message: `Quint found a counterexample for ${property}`,
      ...(trace ? { trace } : {}),
    };
  }
  return {
    ...common,
    status: 'error',
    message: result.message ?? `Quint returned an unrecognized result for ${property}`,
  };
}

export function evidenceForQuint(ref: QuintFormalCheck): FormalEvidence {
  if (ref.mode === 'simulate') return 'simulation';
  return ref.backend === 'tlc' ? 'exhaustive-model-check' : 'bounded-model-check';
}

export function scopeForQuint(ref: QuintFormalCheck): FormalScope {
  return {
    mode: ref.mode,
    backend: ref.backend,
    kind: ref.kind,
    ...(ref.maxSteps === undefined ? {} : { maxSteps: ref.maxSteps }),
    ...(ref.mode === 'simulate' ? { samples: ref.samples, seed: ref.seed } : {}),
  };
}

/** Build the Quint command line for one linked property. Exported for tests. */
export function quintArgs(ref: QuintFormalCheck, file: string, port?: number): string[] {
  const property = ref.kind === 'temporal' ? '--temporal' : '--invariant';
  if (ref.mode === 'simulate') {
    return [
      'run',
      file,
      '--backend',
      'typescript',
      property,
      ref.property,
      '--max-steps',
      String(ref.maxSteps),
      '--max-samples',
      String(ref.samples),
      '--seed',
      String(ref.seed),
      '--verbosity',
      '3',
      ...(ref.main ? ['--main', ref.main] : []),
    ];
  }
  return [
    'verify',
    file,
    '--backend',
    ref.backend,
    property,
    ref.property,
    ...(ref.backend === 'apalache' ? ['--max-steps', String(ref.maxSteps ?? 10)] : []),
    '--verbosity',
    '3',
    ...(ref.main ? ['--main', ref.main] : []),
    ...(port === undefined ? [] : ['--server-endpoint', `127.0.0.1:${port}`]),
  ];
}

export async function checkQuint(
  ref: QuintFormalCheck,
  file: string,
  options: QuintRunnerOptions,
): Promise<FormalOutcome> {
  const evidence = evidenceForQuint(ref);
  const scope = scopeForQuint(ref);
  let port: number | undefined;
  if (ref.mode === 'verify' && ref.backend === 'apalache') {
    try {
      port = await (options.allocatePort ?? allocateLoopbackPort)();
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
  const args = quintArgs(ref, file, port);

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
