import * as fs from 'fs';
import * as path from 'path';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { loadSpec } from '../../spec/parser.js';
import { specToYaml } from '../../spec/parser.js';
import type { GapReport } from '../../validation/types.js';
import { analyzeGaps, applyRefinements, suggestionsToMarkdown } from '../../spec/refiner.js';
import { formatOutput } from '../output.js';

export interface SpecRefineOptions {
  spec: string;
  report: string;
  output?: string;
}

export async function specRefine(options: SpecRefineOptions, ctx: CliContext): Promise<number> {
  if (!options.spec || !options.report) {
    process.stderr.write('Error: --spec and --report are required\n');
    return ExitCode.PARSE_ERROR;
  }

  // Load spec
  let spec;
  try {
    spec = loadSpec(options.spec);
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Load report
  let report: GapReport;
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(options.report), 'utf-8')) as GapReport;
  } catch (err) {
    process.stderr.write(`Failed to load report: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Analyze gaps
  const suggestions = analyzeGaps(spec, report);

  if (suggestions.length === 0) {
    if (ctx.outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ suggestions: [], message: 'No refinements needed' }) + '\n');
    } else if (!ctx.quiet) {
      process.stdout.write('No refinement suggestions — spec is well-aligned with capture.\n');
    }
    return ExitCode.SUCCESS;
  }

  // Apply refinements
  const refined = applyRefinements(spec, suggestions);

  // Output suggestions
  if (ctx.outputFormat === 'json') {
    process.stdout.write(formatOutput({ suggestions, refined }, ctx) + '\n');
  } else if (!ctx.quiet) {
    process.stdout.write(suggestionsToMarkdown(suggestions) + '\n');
  }

  // Write refined spec if --output specified
  if (options.output) {
    const outputPath = path.resolve(options.output);
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, specToYaml(refined), 'utf-8');
    if (!ctx.quiet) {
      process.stderr.write(`Refined spec written to: ${outputPath}\n`);
    }
  }

  return ExitCode.SUCCESS;
}
