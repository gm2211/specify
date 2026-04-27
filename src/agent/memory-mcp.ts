/**
 * src/agent/memory-mcp.ts — In-process MCP server exposing the learned-memory
 * store to the verify agent.
 *
 * Gives the agent a `memory_record` tool (to write a playbook/quirk/observation
 * learned during the run) and a `memory_list` tool (to re-read what's stored,
 * typically used during reflection).
 *
 * The store is scoped to a single (spec, target) pair via the MemoryScope
 * passed in at server construction — the agent cannot write to other
 * specs/targets even by accident. The actual storage backend is a
 * MemoryProvider, defaulting to file-backed.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DeltaInput } from './memory.js';
import {
  defaultMemoryProvider,
  scopeTargetKey,
  type MemoryProvider,
  type MemoryScope,
} from './memory-provider.js';

export interface MemoryMcpContext {
  scope: MemoryScope;
  runId: string;
  provider?: MemoryProvider;
}

export function createMemoryMcpServer(ctx: MemoryMcpContext) {
  const provider = ctx.provider ?? defaultMemoryProvider();
  return createSdkMcpServer({
    name: 'memory',
    tools: [
      tool(
        'memory_record',
        [
          'Persist a durable lesson learned during this verify run so future runs',
          'can see it. Use sparingly: only for facts that are stable across runs',
          '(playbook: "to verify X, do Y then Z"), site-level quirks, or persistent',
          'bugs worth filing-and-continuing on. Do NOT record per-run observations.',
        ].join(' '),
        {
          type: z.enum(['observation', 'playbook', 'quirk']),
          content: z.string().describe('Plain-language fact, playbook, or quirk'),
          area_id: z.string().optional(),
          behavior_id: z.string().optional(),
          suggested_fix: z.string().optional().describe('For quirks, the fix you would propose'),
          severity: z.enum(['cosmetic', 'minor', 'major', 'critical']).optional(),
          contradicts_id: z.string().optional().describe('Pass an existing row id to mark it contradicted'),
        },
        async (args) => {
          const delta: DeltaInput = {
            type: args.type,
            content: args.content,
            area_id: args.area_id,
            behavior_id: args.behavior_id,
            suggested_fix: args.suggested_fix,
            severity: args.severity,
            id: args.contradicts_id,
            contradicts: Boolean(args.contradicts_id),
          };
          const next = await provider.write(ctx.scope, ctx.runId, [delta]);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ ok: true, rows: next.rows.length }),
            }],
          };
        },
      ),
      tool(
        'memory_list',
        [
          'List all durable memory rows for this spec+target. Useful at the start',
          'of a run to see what was learned previously, or during reflection to',
          'decide what to update.',
        ].join(' '),
        {
          type: z.enum(['observation', 'playbook', 'quirk']).optional(),
        },
        async (args) => {
          const file = await provider.read(ctx.scope);
          const rows = args.type ? file.rows.filter((r) => r.type === args.type) : file.rows;
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }],
          };
        },
      ),
    ],
  });
}

/** Re-exported for callers that need to derive the same key the provider uses. */
export { scopeTargetKey };
