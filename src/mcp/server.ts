/**
 * src/mcp/server.ts — MCP server for Specify
 *
 * Exposes Specify capabilities as MCP tools so any LLM client
 * (Claude Desktop, Cursor, Claude Code, etc.) can discover and invoke them.
 *
 * Usage:
 *   specify mcp                          # stdio transport (local)
 *   specify mcp --http --port 8080       # HTTP transport (remote)
 *
 * Local (stdio) config:
 *   { "mcpServers": { "specify": { "command": "specify", "args": ["mcp"] } } }
 *
 * Remote (HTTP) config:
 *   { "mcpServers": { "specify": { "url": "http://host:8080/mcp" } } }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

export interface McpServerOptions {
  /** Use HTTP transport instead of stdio. */
  http?: boolean;
  /** Port for HTTP transport (default: 8080). */
  port?: number;
  /** Host to bind to (default: 0.0.0.0). */
  host?: string;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = new McpServer({
    name: 'specify',
    version: '0.1.0',
  });

  registerTools(server);

  if (options.http) {
    await startHttpTransport(server, options);
  } else {
    await startStdioTransport(server);
  }
}

async function startStdioTransport(server: McpServer): Promise<void> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Specify MCP server started (stdio)\n');
}

async function startHttpTransport(server: McpServer, options: McpServerOptions): Promise<void> {
  const { createServer } = await import('http');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { randomUUID } = await import('crypto');

  const port = options.port ?? 8080;
  const host = options.host ?? '0.0.0.0';

  // Track transports by session for cleanup
  type TransportInstance = InstanceType<typeof StreamableHTTPServerTransport>;
  const transports = new Map<string, TransportInstance>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Only handle /mcp endpoint
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // Parse body for POST requests
    if (req.method === 'POST') {
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, parsed);
        return;
      }

      // New session — create transport and connect
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      await server.connect(transport);

      // Store by session ID after connection
      const sid = transport.sessionId;
      if (sid) transports.set(sid, transport);

      await transport.handleRequest(req, res, parsed);
    } else if (req.method === 'GET') {
      // SSE stream for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid session ID' }));
      }
    } else if (req.method === 'DELETE') {
      // Session termination
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`Specify MCP server started (HTTP)\n`);
    process.stderr.write(`  Endpoint: http://${host}:${port}/mcp\n`);
    process.stderr.write(`  Config:   { "mcpServers": { "specify": { "url": "http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp" } } }\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    process.stderr.write('\nShutting down MCP server...\n');
    for (const transport of transports.values()) {
      transport.close?.();
    }
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
