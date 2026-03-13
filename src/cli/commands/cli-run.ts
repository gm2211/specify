/**
 * src/cli/commands/cli-run.ts — Run CLI verification against a spec
 */

import { loadSpec, parseSpec } from '../../spec/parser.js';
import { runCliValidation, cliReportToMarkdown } from '../../cli-test/runner.js';
import type { Spec } from '../../spec/types.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';

export interface CliRunOptions {
  spec: string;
  output?: string;
}

export async function cliRun(options: CliRunOptions, ctx: CliContext): Promise<number> {
  // Load spec
  let spec: Spec;
  try {
    if (options.spec === '-') {
      const input = await readStdin();
      spec = parseSpec(input);
    } else {
      spec = loadSpec(options.spec);
    }
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  if (!spec.cli) {
    process.stderr.write('Spec has no cli section.\n');
    return ExitCode.PARSE_ERROR;
  }

  // Run validation
  const result = await runCliValidation({
    spec,
    outputDir: options.output,
    log: ctx.quiet ? undefined : (msg) => process.stderr.write(msg + '\n'),
  });

  const { report } = result;

  // Output
  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    if (!ctx.quiet) process.stdout.write(formatOutput(report, ctx) + '\n');
  } else if (ctx.outputFormat === 'markdown') {
    if (!ctx.quiet) process.stdout.write(cliReportToMarkdown(report) + '\n');
  } else {
    // Text: show markdown to stdout
    if (!ctx.quiet) process.stdout.write(cliReportToMarkdown(report) + '\n');
  }

  // Summary to stderr
  if (!ctx.quiet) {
    const { summary } = report;
    process.stderr.write(`\nPassed: ${summary.passed}  Failed: ${summary.failed}  Untested: ${summary.untested}  Coverage: ${summary.coverage}%\n`);
  }

  if (report.summary.failed > 0) return ExitCode.ASSERTION_FAILURE;
  if (report.summary.passed === 0 && report.summary.untested === report.summary.total) return ExitCode.ALL_UNTESTED;
  return ExitCode.SUCCESS;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
