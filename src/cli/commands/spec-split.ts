/**
 * src/cli/commands/spec-split.ts — Convert one large spec file into a spec directory.
 */

import * as path from 'path';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { c } from '../colors.js';
import { splitSpecFileToDirectory } from '../../spec/size-guard.js';

export interface SpecSplitOptions {
  spec: string;
  output?: string;
  force?: boolean;
}

export async function specSplit(options: SpecSplitOptions, ctx: CliContext): Promise<number> {
  if (!options.spec) {
    process.stderr.write('Missing --spec\n');
    return ExitCode.PARSE_ERROR;
  }
  if (options.spec === '-') {
    process.stderr.write('Cannot split stdin; provide a spec file path.\n');
    return ExitCode.PARSE_ERROR;
  }

  try {
    const result = splitSpecFileToDirectory(options.spec, {
      outputDir: options.output,
      force: options.force,
    });

    if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
      process.stdout.write(JSON.stringify({
        outputDir: result.outputDir,
        manifest: result.manifestPath,
        areas: result.areaPaths,
      }, null, 2) + '\n');
    }

    if (!ctx.quiet) {
      process.stderr.write(`${c.boldGreen('✓ Split spec into directory')}\n`);
      process.stderr.write(`  ${c.cyan('Manifest:')} ${result.manifestPath}\n`);
      process.stderr.write(`  ${c.cyan('Areas:')} ${result.areaPaths.length} file${result.areaPaths.length === 1 ? '' : 's'}\n`);
      process.stderr.write(`  ${c.dim(`Use --spec ${path.relative(process.cwd(), result.outputDir) || result.outputDir}`)}\n`);
    }

    return ExitCode.SUCCESS;
  } catch (err) {
    process.stderr.write(`Spec split failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.PARSE_ERROR;
  }
}
