/** TLC proof verdicts are distinct from simulation traces. A counterexample is
 * useful simulation output, but must never be interpreted as a proof success. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnQuint, type QuintExec, type ExecResult } from './quint-runner.js';

export function verificationVerdict(result: ExecResult): 'verified' | 'counterexample' | 'error' {
  if (result.spawnError || result.code === null || result.stdoutTruncated || result.stderrTruncated)
    return 'error';
  const output = result.stdout + '\n' + result.stderr;
  if (result.code === 0 && output.includes('Model checking completed. No error has been found.'))
    return 'verified';
  if (result.code !== 0 && output.includes('found a counterexample')) return 'counterexample';
  return 'error';
}

export interface VerificationOptions {
  binary: string;
  specPath: string;
  main?: string;
  invariant: string;
  temporal: string[];
  apalacheVersion: string;
  tlcConfig: string;
  timeoutMs: number;
  exec?: QuintExec;
}

/** Each invocation owns both its JVM module-extraction directory and server port. */
export async function verifyQuint(options: VerificationOptions) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'specify-tlc-'));
  try {
    const socket = net.createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', resolve);
    });
    const address = socket.address() as net.AddressInfo;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const argv = [
      options.binary,
      'verify',
      options.specPath,
      '--backend',
      'tlc',
      '--invariant',
      options.invariant,
      '--apalache-version',
      options.apalacheVersion,
      '--server-endpoint',
      `127.0.0.1:${address.port}`,
      '--tlc-config',
      options.tlcConfig,
      '--verbosity',
      '3',
    ];
    if (options.main) argv.push('--main', options.main);
    if (options.temporal.length) argv.push('--temporal', options.temporal.join(','));
    const result = await (options.exec ?? spawnQuint)(argv, {
      cwd: scratch,
      timeoutMs: options.timeoutMs,
      env: {
        TMPDIR: scratch,
        JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ''} -Djava.io.tmpdir="${scratch}"`,
      },
    });
    const output = result.stdout + '\n' + result.stderr;
    return {
      verdict: verificationVerdict(result),
      output,
      argv,
      exitCode: result.code,
      error: result.spawnError,
      states:
        [...output.matchAll(/(?:^|\n)\d+ states generated, (\d+) distinct states found/g)].at(
          -1,
        )?.[1] ?? null,
      tlc: output.match(/TLC2 Version ([^\n]+)/)?.[1],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
