/**
 * src/cli/commands/serve.ts — Start the review webapp dev server
 *
 * `specify serve [--spec <path>] [--port <port>] [--no-open] [--agent-report <path>]`
 *
 * Starts a Hono HTTP server serving the built React review app with
 * live-reload via WebSocket. This command blocks until killed.
 */

import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';

export interface ServeCommandOptions {
  spec?: string;
  port?: string;
  noOpen?: boolean;
  agentReport?: string;
}

export async function serveCommand(options: ServeCommandOptions, ctx: CliContext): Promise<number> {
  // Validate spec path
  if (!options.spec) {
    const err = { error: 'missing_parameter', parameter: '--spec', message: 'Spec file path is required' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const port = options.port ? parseInt(options.port, 10) : 3000;
  if (isNaN(port) || port < 1 || port > 65535) {
    const err = { error: 'invalid_parameter', parameter: '--port', message: 'Port must be a number between 1 and 65535' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  try {
    const { startReviewServer } = await import('../../review/server.js');
    await startReviewServer({
      specPath: options.spec,
      port,
      open: !options.noOpen,
      agentReport: options.agentReport,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Server error: ${msg}\n`);
    return ExitCode.PARSE_ERROR;
  }

  return ExitCode.SUCCESS;
}
