import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { startViewer } from '../../view/server.js';

export interface ViewOptions {
  spec: string;
  port?: string;
  noOpen?: boolean;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error('--port must be an integer from 0 to 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return port;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
    child.once('error', (error) => {
      process.stderr.write(`Could not open browser: ${error.message}\n`);
    });
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not open browser: ${message}\n`);
  }
}

export async function view(options: ViewOptions, _ctx: CliContext): Promise<number> {
  const { server, url } = await startViewer(options.spec, parsePort(options.port));
  process.stdout.write(`Specify viewer: ${url}\n`);
  if (!options.noOpen) openBrowser(url);
  await waitForShutdown(server);
  return ExitCode.SUCCESS;
}

function waitForShutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      server.close(() => resolve());
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
