import * as fs from 'fs';
import * as path from 'path';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import type { GapReport } from '../../validation/types.js';
import { diffReports, diffToMarkdown } from '../../history/diff.js';
import { formatOutput } from '../output.js';

export interface ReportDiffOptions {
  a: string;
  b: string;
}

export async function reportDiff(options: ReportDiffOptions, ctx: CliContext): Promise<number> {
  if (!options.a || !options.b) {
    process.stderr.write('Error: --a and --b are required\n');
    return ExitCode.PARSE_ERROR;
  }

  let reportA: GapReport;
  let reportB: GapReport;

  try {
    reportA = JSON.parse(fs.readFileSync(path.resolve(options.a), 'utf-8')) as GapReport;
  } catch (err) {
    process.stderr.write(`Failed to load report A: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  try {
    reportB = JSON.parse(fs.readFileSync(path.resolve(options.b), 'utf-8')) as GapReport;
  } catch (err) {
    process.stderr.write(`Failed to load report B: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const diff = diffReports(reportA, reportB);

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(formatOutput(diff, ctx) + '\n');
  } else {
    process.stdout.write(diffToMarkdown(diff) + '\n');
  }

  // Exit 1 if new failures found
  return diff.summary.new_failures > 0 ? ExitCode.ASSERTION_FAILURE : ExitCode.SUCCESS;
}
