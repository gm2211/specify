/**
 * src/cli/commands/spec-guide.ts — Output authoring guidance for LLM spec writers
 *
 * Emits schema + examples + patterns + tips in a single structured output
 * so an LLM can write valid Specify specs without trial and error.
 */

import { getAuthoringGuide } from '../../spec/guide.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';

export async function specGuide(_ctx: CliContext): Promise<number> {
  const guide = getAuthoringGuide();
  process.stdout.write(JSON.stringify(guide, null, 2) + '\n');
  return ExitCode.SUCCESS;
}
