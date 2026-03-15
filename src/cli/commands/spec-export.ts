/**
 * src/cli/commands/spec-export.ts — Export spec as e2e test code
 *
 * Runs the spec-to-test generator and writes files or outputs to stdout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadSpec, parseSpec } from '../../spec/parser.js';
import { generateTestsFromSpec } from '../../e2e/spec-to-test.js';
import type { Spec } from '../../spec/types.js';
import type { GenerateOptions } from '../../e2e/types.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';
import { readStdin } from '../stdin.js';

export interface SpecExportOptions {
  spec: string;
  framework: string;
  output?: string;
  splitFiles?: boolean;
}

export async function specExport(options: SpecExportOptions, ctx: CliContext): Promise<number> {
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

  // Validate framework
  const framework = options.framework as 'playwright' | 'cypress';
  if (framework !== 'playwright' && framework !== 'cypress') {
    process.stderr.write(`Unsupported framework: ${options.framework}. Use 'playwright' or 'cypress'.\n`);
    return ExitCode.PARSE_ERROR;
  }

  const generateOptions: GenerateOptions = {
    framework,
    baseUrl: spec.variables?.base_url,
    splitFiles: options.splitFiles,
  };

  const files = generateTestsFromSpec(spec, generateOptions);

  if (files.length === 0) {
    process.stderr.write('No test code generated — spec has no pages or flows.\n');
    return ExitCode.SUCCESS;
  }

  // Write to output directory or stdout
  if (options.output) {
    const outDir = path.resolve(options.output);
    fs.mkdirSync(outDir, { recursive: true });

    for (const file of files) {
      const filePath = path.join(outDir, file.filePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
      if (!ctx.quiet) process.stderr.write(`  Written: ${path.relative(process.cwd(), filePath)}\n`);
    }
    if (!ctx.quiet) process.stderr.write(`\n${files.length} file(s) generated in ${outDir}\n`);
  } else {
    // Output to stdout
    if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
      const result = files.map(f => ({
        filePath: f.filePath,
        content: f.content,
        framework: f.framework,
        sourceSpecIds: f.sourceSpecIds,
      }));
      if (!ctx.quiet) process.stdout.write(formatOutput(result, ctx) + '\n');
    } else {
      // Human-readable: output code directly
      for (const file of files) {
        if (files.length > 1) {
          process.stdout.write(`// --- ${file.filePath} ---\n`);
        }
        process.stdout.write(file.content + '\n');
      }
    }
  }

  return ExitCode.SUCCESS;
}
