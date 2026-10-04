import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadSpec } from '../spec/parser.js';
import { viewerHtml } from './page.js';

export interface ViewerServer {
  server: Server;
  url: string;
}

function send(
  res: import('node:http').ServerResponse,
  status: number,
  body: string,
  type: string,
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function localAuthority(value: string, port: number): boolean {
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

export async function startViewer(specPath: string, port = 0): Promise<ViewerServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Port must be an integer from 0 to 65535');
  }
  // Validate before binding, so a bad initial spec cannot leave a live server behind.
  loadSpec(specPath);

  const server = createServer(async (req, res) => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const host = req.headers.host;
    if (!host || !localAuthority(host.toLowerCase(), actualPort)) {
      send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(origin);
      } catch {
        send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
        return;
      }
      if (
        parsedOrigin.protocol !== 'http:' ||
        parsedOrigin.username !== '' ||
        parsedOrigin.password !== '' ||
        parsedOrigin.pathname !== '/' ||
        parsedOrigin.search !== '' ||
        parsedOrigin.hash !== '' ||
        !localAuthority(parsedOrigin.host.toLowerCase(), actualPort)
      ) {
        send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
        return;
      }
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
    } catch {
      send(res, 400, 'Bad request', 'text/plain; charset=utf-8');
      return;
    }

    if (pathname === '/') {
      send(res, 200, viewerHtml(), 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/client.js') {
      try {
        const clientPath = fileURLToPath(new URL('./client.js', import.meta.url));
        const client = await readFile(clientPath, 'utf8');
        send(res, 200, client, 'text/javascript; charset=utf-8');
      } catch {
        send(res, 404, 'Viewer client unavailable', 'text/plain; charset=utf-8');
      }
      return;
    }
    if (pathname === '/spec') {
      try {
        const spec = loadSpec(specPath);
        send(
          res,
          200,
          JSON.stringify({
            name: spec.name,
            description: spec.description,
            assumptions: spec.assumptions ?? [],
            areas: spec.areas,
          }),
          'application/json; charset=utf-8',
        );
      } catch {
        send(
          res,
          500,
          JSON.stringify({ error: 'Unable to load spec' }),
          'application/json; charset=utf-8',
        );
      }
      return;
    }
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Unable to determine viewer address');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}
