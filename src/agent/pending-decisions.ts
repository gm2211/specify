import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { eventBus } from './event-bus.js';
import type { MemoryScope } from './memory-provider.js';
import type { DeltaInput } from './memory.js';

export type DecisionScope = 'narrow' | 'medium' | 'broad';

export interface ProposedResolution {
  scope: DecisionScope;
  label: string;
  action_hint?: string;
}

export interface PendingDecision {
  id: string;
  createdAt: string;
  specId: string;
  runId: string;
  area_id?: string;
  behavior_id?: string;
  question: string;
  context: string;
  proposed_resolutions: ProposedResolution[];
  status: 'open' | 'resolved' | 'expired';
  resolved?: {
    at: string;
    resolved_by?: string;
    resolution_index: number;
    scope: DecisionScope;
    note?: string;
  };
}

interface AwaiterEntry {
  resolve: (d: PendingDecision) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const awaiters = new Map<string, AwaiterEntry>();

function decisionsDir(): string {
  return path.join(os.homedir(), '.specify', 'decisions');
}

function decisionsPath(specId: string): string {
  return path.join(decisionsDir(), `${specId}.jsonl`);
}

function generateId(): string {
  return `dec_${randomBytes(4).toString('hex')}`;
}

function readLines(filePath: string): PendingDecision[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const results: PendingDecision[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as PendingDecision);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

function rewriteFile(filePath: string, decisions: PendingDecision[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
}

export function appendDecision(
  d: Omit<PendingDecision, 'id' | 'createdAt' | 'status'>,
): PendingDecision {
  const decision: PendingDecision = {
    ...d,
    id: generateId(),
    createdAt: new Date().toISOString(),
    status: 'open',
  };
  const filePath = decisionsPath(d.specId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(decision) + '\n');
  return decision;
}

export function listDecisions(
  specId?: string,
  opts?: { status?: PendingDecision['status'] },
): PendingDecision[] {
  let decisions: PendingDecision[] = [];
  if (specId) {
    decisions = readLines(decisionsPath(specId));
  } else {
    const dir = decisionsDir();
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.jsonl')) {
          decisions.push(...readLines(path.join(dir, file)));
        }
      }
    }
  }
  if (opts?.status) {
    decisions = decisions.filter((d) => d.status === opts.status);
  }
  return decisions;
}

export function getDecision(id: string): PendingDecision | undefined {
  const dir = decisionsDir();
  if (!fs.existsSync(dir)) return undefined;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const found = readLines(path.join(dir, file)).find((d) => d.id === id);
    if (found) return found;
  }
  return undefined;
}

export async function resolveDecision(
  id: string,
  opts: {
    resolution_index: number;
    scope: DecisionScope;
    resolved_by?: string;
    note?: string;
  },
  memoryWriter?: (scope: MemoryScope, runId: string, deltas: DeltaInput[]) => Promise<void>,
  memoryScope?: MemoryScope,
): Promise<PendingDecision> {
  const dir = decisionsDir();
  if (!fs.existsSync(dir)) throw new Error(`Decision not found: ${id}`);

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, file);
    const decisions = readLines(filePath);
    const idx = decisions.findIndex((d) => d.id === id);
    if (idx === -1) continue;

    const decision = decisions[idx];
    if (decision.status !== 'open') {
      throw new Error(`Decision ${id} is not open (status: ${decision.status})`);
    }
    const proposal = decision.proposed_resolutions[opts.resolution_index];
    if (!proposal) {
      throw new Error(`Invalid resolution_index ${opts.resolution_index}`);
    }
    if (proposal.scope !== opts.scope) {
      throw new Error(
        `Scope mismatch: proposal at index ${opts.resolution_index} has scope "${proposal.scope}", got "${opts.scope}"`,
      );
    }

    const resolved: PendingDecision = {
      ...decision,
      status: 'resolved',
      resolved: {
        at: new Date().toISOString(),
        resolved_by: opts.resolved_by,
        resolution_index: opts.resolution_index,
        scope: opts.scope,
        note: opts.note,
      },
    };
    decisions[idx] = resolved;
    rewriteFile(filePath, decisions);

    eventBus.send('feedback:decision_resolved', {
      id,
      specId: decision.specId,
      runId: decision.runId,
      scope: opts.scope,
      resolution_index: opts.resolution_index,
    });

    if (memoryWriter && memoryScope && (opts.scope === 'medium' || opts.scope === 'broad')) {
      const content = `Human ruling on "${decision.question}": ${proposal.label}${proposal.action_hint ? ' — ' + proposal.action_hint : ''}`;
      const type = opts.scope === 'broad' ? 'playbook' : 'observation';
      const delta: DeltaInput = {
        type,
        content,
        area_id: opts.scope === 'medium' ? decision.area_id : undefined,
        behavior_id: opts.scope === 'medium' ? decision.behavior_id : undefined,
      };
      await memoryWriter(memoryScope, decision.runId, [delta]);
    }

    const awaiter = awaiters.get(id);
    if (awaiter) {
      clearTimeout(awaiter.timeout);
      awaiters.delete(id);
      awaiter.resolve(resolved);
    }

    return resolved;
  }

  throw new Error(`Decision not found: ${id}`);
}

export function registerAwaiter(
  id: string,
  timeoutMs: number,
): Promise<PendingDecision> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      awaiters.delete(id);
      reject(new Error('timeout'));
    }, timeoutMs);
    awaiters.set(id, { resolve, reject, timeout });
  });
}

export function expireAwaiter(id: string): void {
  const awaiter = awaiters.get(id);
  if (awaiter) {
    clearTimeout(awaiter.timeout);
    awaiters.delete(id);
    awaiter.reject(new Error('expired'));
  }
}

export const _internals = { generateId, readLines, decisionsPath };
