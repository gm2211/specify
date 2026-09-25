import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

test('MCP exposes only local contract authoring and discovery', async () => {
  const tools = new Map<string, (...args: any[]) => Promise<any>>();
  registerTools({
    registerTool(name: string, _config: unknown, handler: (...args: any[]) => Promise<any>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer);
  assert.deepEqual([...tools.keys()].sort(), [
    'get_authoring_guide',
    'lint_spec',
    'list_commands',
    'parse_spec',
    'spec_to_yaml',
  ]);
  const guideResult = await tools.get('get_authoring_guide')!();
  const guide = JSON.parse(guideResult.content[0].text);
  assert.ok(guide.examples.length > 0);
  const content = guide.examples[0].yaml;
  const parsed = await tools.get('parse_spec')!({ content });
  assert.ok(!parsed.isError);
  const linted = await tools.get('lint_spec')!({ content });
  assert.equal(JSON.parse(linted.content[0].text).valid, true);
  const invalid = await tools.get('parse_spec')!({ content: '{}' });
  assert.equal(invalid.isError, true);
});
