import * as fs from 'fs';
import * as path from 'path';
import { loadSpec, parseSpec } from '../../spec/parser.js';
import { loadCaptureData, validate } from '../../validation/validator.js';
import { validateAssumptions, allAssumptionsMet } from '../../validation/assumptions.js';
import { toJson, toMarkdown } from '../../validation/reporter.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';
import type { Spec } from '../../spec/types.js';
import { isV1 } from '../../spec/types.js';
import { readStdin } from '../stdin.js';

export interface SpecValidateOptions {
  spec: string; // path or '-' for stdin
  capture: string;
  output?: string;
  historyDir?: string;
}

export async function specValidate(options: SpecValidateOptions, ctx: CliContext): Promise<number> {
  // Load spec (support stdin)
  let spec: Spec;
  try {
    if (options.spec === '-') {
      const input = await readStdin();
      spec = parseSpec(input);
    } else {
      spec = loadSpec(options.spec);
    }
  } catch (err) {
    if (!ctx.quiet) {
      process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    }
    return ExitCode.PARSE_ERROR;
  }

  // Check assumptions (v1 only)
  if (isV1(spec) && spec.assumptions?.length) {
    try {
      const assumptionResults = await validateAssumptions(spec.assumptions, {
        variables: spec.variables,
        baseUrl: spec.variables?.base_url,
      });
      if (!allAssumptionsMet(assumptionResults)) {
        const failedAssumptions = assumptionResults.filter(a => a.status === 'failed');
        if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
          process.stdout.write(formatOutput({ assumptions: assumptionResults, met: false }, ctx) + '\n');
        } else if (!ctx.quiet) {
          process.stderr.write(`Assumptions not met:\n`);
          for (const a of failedAssumptions) {
            process.stderr.write(`  - ${a.type}: ${a.reason}\n`);
          }
        }
        return ExitCode.ASSUMPTION_FAILURE;
      }
    } catch {
      // Non-fatal: continue with validation
    }
  }

  // Load capture
  let capture;
  try {
    capture = loadCaptureData(options.capture);
  } catch (err) {
    if (!ctx.quiet) {
      process.stderr.write(`Failed to load capture data: ${(err as Error).message}\n`);
    }
    return ExitCode.PARSE_ERROR;
  }

  // Run validation
  const report = validate(spec, capture);

  // Output
  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    const output = ctx.fields
      ? formatOutput(report, ctx)
      : toJson(report);
    if (!ctx.quiet) process.stdout.write(output + '\n');
  } else if (ctx.outputFormat === 'markdown') {
    if (!ctx.quiet) process.stdout.write(toMarkdown(report) + '\n');
  } else {
    if (!ctx.quiet) process.stdout.write(toMarkdown(report) + '\n');
  }

  // Write files
  if (options.output) {
    const outDir = path.resolve(options.output);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'gap-report.json'), toJson(report), 'utf-8');
    fs.writeFileSync(path.join(outDir, 'gap-report.md'), toMarkdown(report), 'utf-8');
  }

  // History save
  if (options.historyDir) {
    const histDir = path.resolve(options.historyDir);
    fs.mkdirSync(histDir, { recursive: true });
    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(histDir, `${runId}.json`), toJson(report), 'utf-8');
  }

  // Exit code
  if (report.summary.failed > 0) return ExitCode.ASSERTION_FAILURE;
  if (report.summary.passed === 0 && report.summary.untested === report.summary.total) return ExitCode.ALL_UNTESTED;
  return ExitCode.SUCCESS;
}
