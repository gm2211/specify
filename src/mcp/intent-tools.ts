import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { captureIntent, getIntentContext } from '../intent/records.js';
import { checkIntentReview, reconcileIntent } from '../intent/review.js';
import { initializeIntent, intentWorkspace } from '../intent/workspace.js';

const location = {
  root: z.string().optional().describe('Repository root; default current directory'),
  pack: z.string().optional().describe('Intent directory inside root; default specify.intent'),
};
async function respond(action: () => unknown) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await action(), null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

export function registerIntentTools(server: McpServer) {
  server.registerTool(
    'initialize_intent',
    {
      title: 'Initialize Intent Workflow',
      description:
        'Create a tracked intent pack and append managed AGENTS.md instructions, preserving unrelated text and hooks. No transcript watcher is installed.',
      inputSchema: location,
    },
    async ({ root, pack }) => respond(() => initializeIntent(root, pack)),
  );
  server.registerTool(
    'capture_intent',
    {
      title: 'Capture Intent',
      description:
        'Create a sourced intent record. JSON requires id, statement, kind (decision/assumption/proposal), source.text (exact wording), appliesTo (relative files or directory prefixes; [] global). Optional rationale, source.reference, behaviorIds, supersedes. Existing IDs cannot be overwritten. Do not promote inferred intent into a decision.',
      inputSchema: { ...location, record: z.string().describe('Intent record as JSON') },
    },
    async ({ root, pack, record }) =>
      respond(() => {
        const workspace = intentWorkspace(root, pack);
        return captureIntent(workspace.packPath, JSON.parse(record));
      }),
  );
  server.registerTool(
    'get_intent_context',
    {
      title: 'Get Intent Context',
      description:
        'Read applicable intent before work. Global decisions always accompany filtered results. Empty search results do not prove no constraints apply.',
      inputSchema: {
        ...location,
        query: z.string().optional(),
        paths: z.array(z.string()).optional(),
      },
    },
    async ({ root, pack, query, paths }) =>
      respond(() => getIntentContext(intentWorkspace(root, pack).packPath, { query, paths })),
  );
  server.registerTool(
    'reconcile_intent',
    {
      title: 'Reconcile Intent',
      description:
        'Save review bound to base commit and current files. JSON: {summary,files:[{path,intentIds,outcome:preserved|changed|unmet|none,reason}],unmet?:[{intentId,reason}]}. Cover every changed file. Record gaps; never weaken requirements to match code. This records process, not semantic proof.',
      inputSchema: { ...location, base: z.string(), review: z.string().describe('Review as JSON') },
    },
    async ({ root, pack, base, review }) =>
      respond(() => reconcileIntent({ ...intentWorkspace(root, pack), base }, JSON.parse(review))),
  );
  server.registerTool(
    'check_intent_review',
    {
      title: 'Check Intent Review',
      description:
        'Check review freshness, record references, file coverage, and unmet intent. Missing review returns changed files for preparation. valid=false blocks completion; success is not semantic or execution proof.',
      inputSchema: { ...location, base: z.string() },
    },
    async ({ root, pack, base }) =>
      respond(() => checkIntentReview({ ...intentWorkspace(root, pack), base })),
  );
}
