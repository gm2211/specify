/**
 * src/cli/commands/spec-refine.ts — DEPRECATED: thin wrapper around spec evolve
 *
 * This command is deprecated in favor of `spec evolve` with the following flag mapping:
 *   spec refine --spec <path>                    → spec evolve --spec <path> --apply
 *   spec refine --spec <path> --report <path>    → spec evolve --spec <path> --report <path>
 *   spec refine --spec <path> --output <path>    → spec evolve --spec <path> --apply --output <path>
 *   spec refine --spec <path> --url <url>        → spec evolve --spec <path> --apply --url <url>
 */

import type { CliContext } from '../types.js';
import { specEvolve, type SpecEvolveOptions } from './spec-evolve.js';

export interface SpecRefineOptions {
  spec: string;
  report?: string;
  url?: string;
  output?: string;
}

export async function specRefine(options: SpecRefineOptions, ctx: CliContext): Promise<number> {
  // Emit deprecation warning to stderr
  process.stderr.write(
    'Warning: "spec refine" is deprecated and will be removed in a future release. Use "spec evolve" instead.\n' +
    (options.report
      ? '  Equivalent: specify spec evolve --spec <path> --report <path>\n'
      : '  Equivalent: specify spec evolve --spec <path> --apply\n') +
    '\n',
  );

  // Map refine options to evolve options
  const evolveOptions: SpecEvolveOptions = {
    spec: options.spec,
    output: options.output,
  };

  if (options.report) {
    // Report mode → evolve --report
    evolveOptions.report = options.report;
  } else {
    // Interactive mode → evolve --apply
    evolveOptions.apply = true;
    evolveOptions.url = options.url;
  }

  return specEvolve(evolveOptions, ctx);
}
