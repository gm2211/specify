/**
 * src/cli/commands/daemon.ts — `specify daemon` entrypoint.
 *
 * Long-running mode: Specify runs idle with zero token usage until another
 * agent (or human) pushes a task into the HTTP inbox.
 */

import { startDaemonServer } from '../../daemon/server.js';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';

export interface DaemonCliOptions {
  port?: string;
  host?: string;
  noAuth?: boolean;
  maxWorkers?: string;
}

export async function daemonCommand(
  opts: DaemonCliOptions,
  _ctx: CliContext,
): Promise<number> {
  const port = opts.port ? parseInt(opts.port, 10) : 4100;
  if (!Number.isFinite(port) || port <= 0) {
    process.stdout.write(JSON.stringify({ error: 'invalid_port', port: opts.port }) + '\n');
    return ExitCode.PARSE_ERROR;
  }
  const maxWorkers = opts.maxWorkers ? parseInt(opts.maxWorkers, 10) : 2;
  if (!Number.isFinite(maxWorkers) || maxWorkers <= 0) {
    process.stdout.write(JSON.stringify({ error: 'invalid_max_workers', value: opts.maxWorkers }) + '\n');
    return ExitCode.PARSE_ERROR;
  }
  await startDaemonServer({
    port,
    host: opts.host ?? '127.0.0.1',
    noAuth: !!opts.noAuth,
    maxWorkers,
  });
  return ExitCode.SUCCESS;
}
