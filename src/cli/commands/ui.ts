/**
 * src/cli/commands/ui.ts — specify ui {start|stop|(none)}
 *
 *   specify ui          Run the review UI in the foreground (Ctrl+C to stop).
 *   specify ui start    Daemonize the UI server; writes .specify/ui.pid.
 *   specify ui stop     Kill the daemonized server.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';

export interface UiOptions {
  spec: string;
  port?: string;
  noOpen?: boolean;
  agentReport?: string;
}

const DEFAULT_PORT = 3000;
const STATE_DIR = '.specify';
const PID_FILE = path.join(STATE_DIR, 'ui.pid');
const LOG_FILE = path.join(STATE_DIR, 'ui.log');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): { pid: number; port: number } | null {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const parsed = JSON.parse(content);
    if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') return parsed;
  } catch {
    // fall through
  }
  return null;
}

/** Foreground: delegates to the existing review server, Ctrl+C exits. */
export async function uiInteractive(options: UiOptions, _ctx: CliContext): Promise<number> {
  if (!options.spec) {
    process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--spec' }) + '\n');
    return ExitCode.PARSE_ERROR;
  }
  const { startReviewServer } = await import('../../review/server.js');
  const port = parseInt(options.port ?? String(DEFAULT_PORT), 10);
  await startReviewServer({
    specPath: options.spec,
    port,
    open: !options.noOpen,
    agentReport: options.agentReport,
  });
  return ExitCode.SUCCESS;
}

/** Daemonize: spawn a detached child and exit. */
export async function uiStart(options: UiOptions, _ctx: CliContext): Promise<number> {
  if (!options.spec) {
    process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--spec' }) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  // Reject if already running.
  const existing = readPidFile();
  if (existing && isAlive(existing.pid)) {
    process.stderr.write(`UI already running — pid ${existing.pid}, http://localhost:${existing.port}\n`);
    return ExitCode.SUCCESS;
  }
  if (existing) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const port = parseInt(options.port ?? String(DEFAULT_PORT), 10);

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');

  // Re-exec this same CLI with `ui --no-open` so the detached child hosts
  // the review server. In dev we're running the .ts entry via tsx; in prod
  // it's bundled .js under node. Pick the right launcher for each.
  const scriptPath = process.argv[1];
  const isTs = scriptPath.endsWith('.ts');
  const cmd = isTs ? 'npx' : process.argv[0];
  const childArgs = isTs
    ? ['tsx', scriptPath, 'ui', '--spec', path.resolve(options.spec), '--port', String(port), '--no-open']
    : [scriptPath, 'ui', '--spec', path.resolve(options.spec), '--port', String(port), '--no-open'];
  if (options.agentReport) childArgs.push('--agent-report', path.resolve(options.agentReport));

  const child = spawn(cmd, childArgs, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();

  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }));

  // Wait briefly for the server to come up so we can verify the URL is live.
  await new Promise((r) => setTimeout(r, 600));

  process.stderr.write(`UI started — pid ${child.pid}, http://localhost:${port}\n`);
  process.stderr.write(`Logs: ${LOG_FILE}\n`);
  process.stderr.write(`Stop: specify ui stop\n`);

  if (!options.noOpen) {
    const { execFile } = await import('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const args = process.platform === 'win32'
      ? ['/c', 'start', '', `http://localhost:${port}`]
      : [`http://localhost:${port}`];
    execFile(cmd, args, () => {});
  }

  return ExitCode.SUCCESS;
}

export async function uiStop(_options: UiOptions, _ctx: CliContext): Promise<number> {
  const existing = readPidFile();
  if (!existing) {
    process.stderr.write('UI not running — no pidfile.\n');
    return ExitCode.SUCCESS;
  }
  if (!isAlive(existing.pid)) {
    process.stderr.write('UI not running — pid stale, cleaning up.\n');
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return ExitCode.SUCCESS;
  }
  try {
    process.kill(existing.pid, 'SIGTERM');
  } catch (err) {
    process.stderr.write(`Failed to kill pid ${existing.pid}: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.BROWSER_ERROR;
  }
  // Give it a second to shut down, then escalate.
  await new Promise((r) => setTimeout(r, 500));
  if (isAlive(existing.pid)) {
    try { process.kill(existing.pid, 'SIGKILL'); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  process.stderr.write(`UI stopped (pid ${existing.pid}).\n`);
  return ExitCode.SUCCESS;
}
