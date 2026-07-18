/**
 * src/cli/commands/spec-lint.ts — Structural and semantic spec validation
 *
 * Unlike `spec validate`, this does NOT require captured data.
 * It checks the spec file itself for structural correctness and common issues.
 */

import * as fs from 'fs';
import * as path from 'path';
import { lintPath, lintRaw, type LintOptions } from '../../spec/lint.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { c } from '../colors.js';
import { readStdin } from '../stdin.js';

export interface SpecLintOptions {
  spec: string;
}

/**
 * Best-effort load of the predicate registry (src/monitor/predicates.ts),
 * so the formulas unknown-predicate lint rule can run. That module is built
 * on a separate branch and may not exist here yet, and its exact export
 * shape isn't finalized, so this tries a few likely names and swallows any
 * import failure — lint must work standalone without it.
 */
async function loadPredicateRegistry(): Promise<ReadonlySet<string> | undefined> {
  try {
    // Import via a non-literal specifier so TS doesn't statically resolve
    // this path — src/monitor/predicates.ts may not exist on every branch.
    const predicatesModulePath = '../../monitor/predicates.js';
    const mod = (await import(predicatesModulePath)) as Record<string, unknown>;
    const candidates = [mod.PREDICATE_NAMES, mod.predicateNames, mod.KNOWN_PREDICATES, mod.predicateRegistry];
    for (const c of candidates) {
      if (c instanceof Set) return c as Set<string>;
      if (Array.isArray(c)) return new Set(c as string[]);
      if (c && typeof c === 'object') return new Set(Object.keys(c as object));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function specLint(options: SpecLintOptions, ctx: CliContext): Promise<number> {
  const lintOptions: LintOptions = { predicateRegistry: await loadPredicateRegistry() };

  let result;
  try {
    if (options.spec === '-') {
      const content = await readStdin();
      result = lintRaw(content, options.spec, undefined, lintOptions);
    } else {
      const resolved = path.resolve(options.spec);
      if (!fs.existsSync(resolved)) {
        process.stderr.write(`Spec source not found: ${resolved}\n`);
        return ExitCode.PARSE_ERROR;
      }
      result = lintPath(resolved, lintOptions);
    }
  } catch (err) {
    process.stderr.write(`Failed to read spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

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
      for (const err of result.errors.filter(e => e.severity === 'warning')) {
        process.stderr.write(`  ${c.yellow('⚠')} ${c.dim(err.path + ':')} ${err.message} ${c.dim(`(${err.rule})`)}\n`);
      }
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
