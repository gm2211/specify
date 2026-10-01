import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { version } from '../version.js';
import { registerTools } from './tools.js';

/** Local authoring tools; no execution, network listener, or agent sessions. */
export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'specify', version });
  registerTools(server);
  await server.connect(new StdioServerTransport());
}
