import { eventBus } from './event-bus.js';

export interface BudgetConfig {
  default: number;
  envName: string;
}

export const TOOL_BUDGETS: Record<string, BudgetConfig> = {
  memory_record:  { default: 50,  envName: 'MEMORY_RECORD' },
  memory_list:    { default: 100, envName: 'MEMORY_LIST' },
  file_ticket:    { default: 10,  envName: 'FILE_TICKET' },
  file_decision:  { default: 5,   envName: 'FILE_DECISION' },
};

const counters = new Map<string, Map<string, number>>();

export function getBudget(toolName: string, env: Record<string, string | undefined> = process.env): number {
  const cfg = TOOL_BUDGETS[toolName];
  if (!cfg) return Infinity;
  const raw = env[`SPECIFY_TOOL_BUDGET_${cfg.envName}`];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return cfg.default;
}

export function enforceBudget(
  runId: string,
  toolName: string,
  env?: Record<string, string | undefined>,
): { ok: true } | { ok: false; limit: number; used: number } {
  const limit = getBudget(toolName, env);
  if (limit === Infinity) return { ok: true };

  let runMap = counters.get(runId);
  if (!runMap) {
    runMap = new Map();
    counters.set(runId, runMap);
  }

  const used = runMap.get(toolName) ?? 0;
  if (used >= limit) {
    eventBus.send('tool:budget_exceeded', { runId, toolName, limit, used });
    return { ok: false, limit, used };
  }

  runMap.set(toolName, used + 1);
  return { ok: true };
}

export function resetRunBudget(runId: string): void {
  counters.delete(runId);
}

export function getRunUsage(runId: string): Record<string, number> {
  const runMap = counters.get(runId);
  if (!runMap) return {};
  return Object.fromEntries(runMap.entries());
}

eventBus.onAny((ev) => {
  if (ev.type === 'inbox:completed' || ev.type === 'inbox:failed') {
    const id = (ev.data.id ?? ev.data.runId) as string | undefined;
    if (id) resetRunBudget(id);
  }
});

export const _internals = { counters };
