import { checkFormal } from '../../formal/check.js';
import { formatReport } from '../../formal/report.js';
import { writeOutput } from '../output.js';
import type { CliContext } from '../types.js';

export interface FormalCheckOptions {
  root?: string;
  timeoutMs?: string;
  quintBin?: string;
  leanBin?: string;
  tool?: string;
}

export async function formalCheck(options: FormalCheckOptions, ctx: CliContext): Promise<number> {
  const timeout = options.timeoutMs ?? '60000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 600000) {
    throw new Error('--timeout-ms must be an integer between 1 and 600000');
  }
  if (options.tool !== undefined && options.tool !== 'quint' && options.tool !== 'lean') {
    throw new Error('--tool must be quint or lean');
  }
  const report = await checkFormal({
    root: options.root ?? '.',
    timeoutMs: Number(timeout),
    quintBin: options.quintBin,
    leanBin: options.leanBin,
    tool: options.tool,
  });
  const human = ctx.outputFormat === 'text' || ctx.outputFormat === 'markdown';
  writeOutput(human && !ctx.fields ? formatReport(report) : report, ctx);
  return report.valid ? 0 : 1;
}
