import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIntentTools } from './intent-tools.js';

test('MCP awaits capture/retrieval and returns validation failures as errors', async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'intent-mcp-'));
  const handlers = new Map<string, (args: any) => Promise<any>>();
  registerIntentTools({
    registerTool(name: string, _config: unknown, handler: any) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer);
  const call = (name: string, args: object) => handlers.get(name)!({ root, ...args });
  try {
    const initialized = await call('initialize_intent', {});
    assert.equal(JSON.parse(initialized.content[0].text).initialized, true);
    const record = JSON.stringify({
      id: 'explicit-intent',
      statement: 'Remember user decisions.',
      kind: 'decision',
      source: { text: 'Remember this.' },
      appliesTo: [],
    });
    const captured = await call('capture_intent', { record });
    assert.equal(JSON.parse(captured.content[0].text).record.id, 'explicit-intent');
    const context = await call('get_intent_context', { query: 'different words' });
    assert.equal(JSON.parse(context.content[0].text).records.length, 1);
    const duplicate = await call('capture_intent', { record });
    const invalid = await call('capture_intent', { record: '{}' });
    assert.equal(duplicate.isError, true);
    assert.equal(invalid.isError, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
