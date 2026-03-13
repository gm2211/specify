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

  const result = lintRaw(content, options.spec);

  // Output
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (!ctx.quiet) {
    const errorCount = result.errors.filter(e => e.severity === 'error').length;
    const warnCount = result.errors.filter(e => e.severity === 'warning').length;

    if (result.valid) {
      process.stderr.write(`Spec is valid`);
      if (warnCount > 0) {
        process.stderr.write(` (${warnCount} warning${warnCount !== 1 ? 's' : ''})`);
      }
      process.stderr.write('\n');
    } else {
      process.stderr.write(`Spec has ${errorCount} error${errorCount !== 1 ? 's' : ''}`);
      if (warnCount > 0) {
        process.stderr.write(` and ${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
      }
      process.stderr.write('\n');
      for (const err of result.errors) {
        const icon = err.severity === 'error' ? 'E' : 'W';
        process.stderr.write(`  [${icon}] ${err.path}: ${err.message} (${err.rule})\n`);
      }
    }
  }

  return result.valid ? ExitCode.SUCCESS : ExitCode.PARSE_ERROR;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
