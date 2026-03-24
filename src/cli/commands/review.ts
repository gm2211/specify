/**
 * src/cli/commands/review.ts — Launch the review webapp
 *
 * `specify review --spec <path> [--port <port>] [--agent-report <path>] [--no-open]`
 *
 * Delegates to `specify serve` — the review webapp replaces the old static HTML generator.
 */

import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';

export interface ReviewOptions {
  spec: string;
  narrative?: string;
  report?: string;
  agentReport?: string;
  output?: string;
  noOpen?: boolean;
  port?: string;
}

export async function review(options: ReviewOptions, ctx: CliContext): Promise<number> {
  if (!options.spec) {
    const err = { error: 'missing_parameter', parameter: '--spec', message: 'Spec file path is required' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const { startReviewServer } = await import('../../review/server.js');
  const port = parseInt(options.port ?? '3000', 10);

  await startReviewServer({
    specPath: options.spec,
    port,
    open: !options.noOpen,
    agentReport: options.agentReport,
  });

  return ExitCode.SUCCESS;
}
