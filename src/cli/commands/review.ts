/**
 * src/cli/commands/review.ts — Launch the review webapp
 *
 * `specify review [--spec <path>] [--port <port>] [--host <host>] [--agent-report <path>] [--no-open]`
 * `specify review --background [--spec <path>] [--port <port>] [--host <host>]`   daemonize
 * `specify review --stop`                                          kill daemon
 *
 * The review API is unauthenticated, so the server binds to loopback-only
 * (127.0.0.1) by default. Widen it with --host or SPECIFY_REVIEW_HOST — see
 * resolveReviewHost() below.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
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
  host?: string;
  background?: boolean;
  stop?: boolean;
}

const DEFAULT_PORT = 3000;
const STATE_DIR = '.specify';
const PID_FILE = path.join(STATE_DIR, 'ui.pid');
const LOG_FILE = path.join(STATE_DIR, 'ui.log');

/**
 * Resolve the interface the review server should bind to: an explicit
 * --host flag wins, then SPECIFY_REVIEW_HOST, then loopback-only
 * (127.0.0.1). The review API is unauthenticated, so the default must never
 * widen to the LAN without an explicit opt-in. Exported for unit testing.
 */
export function resolveReviewHost(cliHost?: string): string {
  const flag = cliHost?.trim();
  if (flag) return flag;
  const envHost = process.env.SPECIFY_REVIEW_HOST?.trim();
  if (envHost) return envHost;
  return '127.0.0.1';
}

function displayUrl(host: string, port: number): string {
  // 0.0.0.0 isn't a client-facing address — show "localhost" for it.
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  return `http://${displayHost}:${port}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): { pid: number; port: number; host?: string } | null {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const parsed = JSON.parse(content);
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') return parsed;
  } catch {
    // fall through
  }
  return null;
}

async function reviewStop(): Promise<number> {
  const existing = readPidFile();
  if (!existing) {
    process.stderr.write('Review not running — no pidfile.\n');
    return ExitCode.SUCCESS;
  }
  if (!isAlive(existing.pid)) {
    process.stderr.write('Review not running — pid stale, cleaning up.\n');
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return ExitCode.SUCCESS;
  }
  try {
    process.kill(existing.pid, 'SIGTERM');
  } catch (err) {
    process.stderr.write(`Failed to kill pid ${existing.pid}: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.BROWSER_ERROR;
  }
  await new Promise((r) => setTimeout(r, 500));
  if (isAlive(existing.pid)) {
    try { process.kill(existing.pid, 'SIGKILL'); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.stderr.write(`Review stopped (pid ${existing.pid}).\n`);
  return ExitCode.SUCCESS;
}

async function reviewBackground(options: ReviewOptions): Promise<number> {
  if (!options.spec) {
    process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--spec' }) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const existing = readPidFile();
  if (existing && isAlive(existing.pid)) {
    process.stderr.write(`Review already running — pid ${existing.pid}, ${displayUrl(existing.host ?? '127.0.0.1', existing.port)}\n`);
    return ExitCode.SUCCESS;
  }
  if (existing) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const port = parseInt(options.port ?? String(DEFAULT_PORT), 10);
  const host = resolveReviewHost(options.host);

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');

  const scriptPath = process.argv[1];
  const isTs = scriptPath.endsWith('.ts');
  const cmd = isTs ? 'npx' : process.argv[0];
  const childArgs = isTs
    ? ['tsx', scriptPath, 'review', '--spec', path.resolve(options.spec), '--port', String(port), '--no-open']
    : [scriptPath, 'review', '--spec', path.resolve(options.spec), '--port', String(port), '--no-open'];
  if (options.agentReport) childArgs.push('--agent-report', path.resolve(options.agentReport));
  // Forward an explicit --host so the detached child (which re-parses its
  // own argv) binds the same interface the caller asked for.
  if (options.host) childArgs.push('--host', options.host);

  const child = spawn(cmd, childArgs, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();

  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port, host, startedAt: new Date().toISOString() }));

  await new Promise((r) => setTimeout(r, 600));

  process.stderr.write(`Review started — pid ${child.pid}, ${displayUrl(host, port)}\n`);
  process.stderr.write(`Logs: ${LOG_FILE}\n`);
  process.stderr.write(`Stop: specify review --stop\n`);

  if (!options.noOpen) {
    const { execFile } = await import('child_process');
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const openUrl = displayUrl(host, port);
    const openArgs = process.platform === 'win32'
      ? ['/c', 'start', '', openUrl]
      : [openUrl];
    execFile(openCmd, openArgs, () => {});
  }

  return ExitCode.SUCCESS;
}

export async function review(options: ReviewOptions, _ctx: CliContext): Promise<number> {
  if (options.stop) {
    return reviewStop();
  }

  if (options.background) {
    return reviewBackground(options);
  }

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
    host: resolveReviewHost(options.host),
  });

  return ExitCode.SUCCESS;
}
