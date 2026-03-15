/**
 * src/cli/commands/spec-lint.ts — Structural and semantic spec validation
 *
 * Unlike `spec validate`, this does NOT require captured data.
 * It checks the spec file itself for structural correctness and common issues.
 */

import * as fs from 'fs';
import * as path from 'path';
import { lintRaw } from '../../spec/lint.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { c } from '../colors.js';
import { readStdin } from '../stdin.js';

export interface SpecLintOptions {
  spec: string;
}

export async function specLint(options: SpecLintOptions, ctx: CliContext): Promise<number> {
  // Load spec content
  let content: string;
  try {
    if (options.spec === '-') {
      content = await readStdin();
    } else {
      const resolved = path.resolve(options.spec);
      if (!fs.existsSync(resolved)) {
        process.stderr.write(`Spec file not found: ${resolved}\n`);
        return ExitCode.PARSE_ERROR;
      }
      content = fs.readFileSync(resolved, 'utf-8');
    }
  } catch (err) {
    process.stderr.write(`Failed to read spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const result = lintRaw(content, options.spec, options.spec !== '-' ? options.spec : undefined);

  // Output — JSON to stdout only in structured output modes (matches other commands)
  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  if (!ctx.quiet) {
    const errorCount = result.errors.filter(e => e.severity === 'error').length;
    const warnCount = result.errors.filter(e => e.severity === 'warning').length;

    if (result.valid) {
      process.stderr.write(c.boldGreen('✓ Spec is valid'));
      if (warnCount > 0) {
        process.stderr.write(c.yellow(` (${warnCount} warning${warnCount !== 1 ? 's' : ''})`));
      }
      process.stderr.write('\n');
    } else {
      process.stderr.write(c.boldRed(`✗ Spec has ${errorCount} error${errorCount !== 1 ? 's' : ''}`));
      if (warnCount > 0) {
        process.stderr.write(c.yellow(` and ${warnCount} warning${warnCount !== 1 ? 's' : ''}`));
      }
      process.stderr.write('\n');
      for (const err of result.errors) {
        const icon = err.severity === 'error' ? c.red('✗') : c.yellow('⚠');
        process.stderr.write(`  ${icon} ${c.dim(err.path + ':')} ${err.message} ${c.dim(`(${err.rule})`)}\n`);
      }
    }
  }

  return result.valid ? ExitCode.SUCCESS : ExitCode.PARSE_ERROR;
}
