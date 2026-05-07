import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { eventBus } from './event-bus.js';
import {
  appendDecision,
  registerAwaiter,
  type DecisionScope,
} from './pending-decisions.js';
import type { MemoryProvider, MemoryScope } from './memory-provider.js';

export interface DecisionsMcpContext {
  specId: string;
  runId: string;
  area_id?: string;
  behavior_id?: string;
  memoryScope: MemoryScope;
  memoryProvider?: MemoryProvider;
}

const ScopeSchema = z.enum(['narrow', 'medium', 'broad'] as [DecisionScope, ...DecisionScope[]]);

const ProposedResolutionSchema = z.object({
  scope: ScopeSchema,
  label: z.string().min(1),
  action_hint: z.string().optional(),
});

export function createDecisionsMcpServer(ctx: DecisionsMcpContext) {
  return createSdkMcpServer({
    name: 'decisions',
    tools: [
      tool(
        'file_decision',
        [
          'Pause the run to ask a human a typed question with pre-drafted resolutions at',
          'narrow (this run only), medium (this behavior — persisted as memory), or broad',
          '(this spec — persisted as memory) scope. The blocking flag holds the run until',
          'a human resolves via POST /decisions/:id/resolve in the cooperative-QA webapp.',
        ].join(' '),
        {
          question: z.string().min(1).describe('One-sentence ask'),
          context: z.string().min(1).describe('Longer description — what the agent saw, repro steps'),
          proposed_resolutions: z.array(ProposedResolutionSchema).min(2),
          blocking: z.boolean().describe('When true, hold the run until a human resolves'),
          timeout_seconds: z.number().optional().describe('Seconds to wait before giving up (default 600, only meaningful when blocking=true)'),
        },
        async (args) => {
          const decision = appendDecision({
            specId: ctx.specId,
            runId: ctx.runId,
            area_id: ctx.area_id,
            behavior_id: ctx.behavior_id,
            question: args.question,
            context: args.context,
            proposed_resolutions: args.proposed_resolutions,
          });

          const scopes = args.proposed_resolutions.map((r) => r.scope);
          eventBus.send('feedback:decision_filed', {
            id: decision.id,
            specId: ctx.specId,
            runId: ctx.runId,
            scopes,
          });

          if (!args.blocking) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ ok: true, id: decision.id, status: 'open' }),
              }],
            };
          }

          const timeoutMs = (args.timeout_seconds ?? 600) * 1000;
          try {
            const resolved = await registerAwaiter(decision.id, timeoutMs);
            const res = resolved.resolved!;
            const proposal = resolved.proposed_resolutions[res.resolution_index];
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  id: decision.id,
                  resolution: {
                    scope: res.scope,
                    resolution_index: res.resolution_index,
                    label: proposal.label,
                    action_hint: proposal.action_hint,
                  },
                }),
              }],
            };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ ok: false, id: decision.id, reason }),
              }],
            };
          }
        },
      ),
    ],
  });
}
