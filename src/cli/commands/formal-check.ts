import { checkFormal } from '../../formal/check.js';
import { writeOutput } from '../output.js';
import type { CliContext } from '../types.js';

export interface FormalCheckOptions {
  spec: string;
  timeoutMs?: string;
  quintBin?: string;
  leanBin?: string;
}

export async function formalCheck(options: FormalCheckOptions, ctx: CliContext): Promise<number> {
  const timeout = options.timeoutMs ?? '60000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 600000) {
    throw new Error('--timeout-ms must be an integer between 1 and 600000');
  }
  const report = await checkFormal({
    spec: options.spec,
    timeoutMs: Number(timeout),
    quintBin: options.quintBin,
    leanBin: options.leanBin,
  });
  writeOutput(report, ctx);
  return report.valid ? 0 : 1;
}
