/**
 * src/agent/memory.ts — Learned memory store for Specify verify agents.
 *
 * Purpose
 *   Let Specify remember things across verify runs of the same (spec, target)
 *   pair — playbooks ("to verify login here, click X then wait 2s then click
 *   Y"), quirks ("this page races: selector #save fires before the XHR
 *   settles"), and raw observations ("dashboard loaded 4.1s on average").
 *
 * Storage
 *   Plain JSON files at `.specify/memory/<spec_id>/<target_key>.json`. Easy
 *   to inspect, easy to diff in git, easy to hand-prune. Upgrade path to
 *   SQLite exists but isn't needed until volume warrants it.
 *
 * Scoping
 *   Strict (spec_id, target_key) by default. target_key is derived from the
 *   URL origin (or `cli:<binary>` for CLI targets) so staging and prod never
 *   cross-contaminate. Callers who want spec-intrinsic facts across targets
 *   can opt in via `loadForSpec`, but never both axes wildcard at once.
 *
 * Lifecycle
 *   - readInject(): load matching rows and format them for the verify prompt.
 *     Caps output at ~2KB to avoid ballooning context.
 *   - recordDeltas(): append new rows from a post-run reflection step,
 *     deduping by id and updating last_confirmed_run_id for existing ones.
 *   - demote(): bump contradicted_count; after 2 contradictions a playbook
 *     is demoted to observation (kept for history, not injected).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type MemoryRowType = 'observation' | 'playbook' | 'quirk';

export interface MemoryRow {
  id: string;
  type: MemoryRowType;
  /** Area id from the spec, if the lesson is tied to a specific area. */
  area_id?: string;
  /** Behavior id, if tied to a specific behavior. */
  behavior_id?: string;
  /** Short plain-language fact, playbook step list, or quirk description. */
  content: string;
  /** Optional fix the agent recommends for a quirk. */
  suggested_fix?: string;
  /** Severity for quirks: cosmetic | minor | major | critical. */
  severity?: 'cosmetic' | 'minor' | 'major' | 'critical';
  /** Run ID that last saw this row confirm in place. */
  last_confirmed_run_id?: string;
  /** How many subsequent runs contradicted this row. 2 → demoted. */
  contradicted_count: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryFile {
  version: 1;
  spec_id: string;
  target_key: string;
  rows: MemoryRow[];
}

export interface TargetDescriptor {
  type: 'web' | 'api' | 'cli';
  url?: string;
  binary?: string;
}

/**
 * Derive a filesystem-safe target key from a spec target. Different URLs on
 * the same origin share state (staging.example.com stays distinct from
 * example.com); a CLI spec keys on its binary path.
 */
export function targetKey(target: TargetDescriptor): string {
  if (target.type === 'cli' && target.binary) {
    return 'cli_' + safe(path.basename(target.binary));
  }
  if (target.url) {
    try {
      const u = new URL(target.url);
      return 'web_' + safe(u.host);
    } catch {
      return 'web_' + safe(target.url);
    }
  }
  return 'unknown';
}

/** Collapse anything that isn't a safe filesystem char. */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/**
 * Resolve the memory file path for a (spec, target) pair.
 * Default root: `<spec_dir>/.specify/memory/<spec_id>/<target_key>.json`.
 */
export function memoryPath(specPath: string, specId: string, target: TargetDescriptor): string {
  const specDir = path.dirname(path.resolve(specPath));
  return path.join(specDir, '.specify', 'memory', safe(specId), targetKey(target) + '.json');
}

export function loadMemory(filePath: string): MemoryFile {
  if (!fs.existsSync(filePath)) {
    const [, specId = 'unknown', tk = 'unknown'] = filePath.split(path.sep).slice(-3).map((s) => s.replace(/\.json$/, ''));
    return { version: 1, spec_id: specId, target_key: tk, rows: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && raw.version === 1 && Array.isArray(raw.rows)) {
      return raw as MemoryFile;
    }
  } catch { /* fall through */ }
  // Corrupted or wrong version — return empty rather than throw so agents
  // can still run. The user can repair the file manually.
  return { version: 1, spec_id: 'unknown', target_key: 'unknown', rows: [] };
}

export function saveMemory(filePath: string, file: MemoryFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}

/**
 * Build a prompt-ready summary of what the agent has learned for this
 * (spec, target) pair. Returns an empty string when nothing is worth
 * injecting. Caps at roughly 2KB.
 */
export function renderMemoryPrompt(file: MemoryFile, budgetBytes = 2048): string {
  const playbooks = file.rows.filter((r) => r.type === 'playbook' && r.contradicted_count < 2);
  const quirks = file.rows.filter((r) => r.type === 'quirk');
  if (!playbooks.length && !quirks.length) return '';

  const parts: string[] = [];
  parts.push('## Prior knowledge about this spec + target');
  parts.push('');
  parts.push('You have verified this target before. Use the following only as a');
  parts.push("starting point — if something contradicts what you actually observe,");
  parts.push('trust the live system and mark the prior belief contradicted.');
  parts.push('');

  if (playbooks.length) {
    parts.push('### Known playbooks');
    for (const p of playbooks) {
      const scope = p.behavior_id ? `(${p.area_id ?? '?'}/${p.behavior_id}) ` : p.area_id ? `(${p.area_id}) ` : '';
      parts.push(`- ${scope}${p.content}`);
    }
    parts.push('');
  }

  if (quirks.length) {
    parts.push('### Known quirks / bugs (file-and-continue, do not block on these)');
    for (const q of quirks) {
      const sev = q.severity ? `[${q.severity}] ` : '';
      const fix = q.suggested_fix ? ` — suggested fix: ${q.suggested_fix}` : '';
      parts.push(`- ${sev}${q.content}${fix}`);
    }
    parts.push('');
  }

  const out = parts.join('\n');
  if (Buffer.byteLength(out, 'utf-8') <= budgetBytes) return out;
  // Trim by dropping oldest playbooks first.
  const head = parts.slice(0, parts.indexOf('### Known playbooks') + 1);
  const tail = quirks.length
    ? parts.slice(parts.indexOf('### Known quirks / bugs (file-and-continue, do not block on these)'))
    : [];
  const trimmed = [...head, '- (older playbooks omitted for size)', '', ...tail].join('\n');
  return trimmed.slice(0, budgetBytes);
}

export interface DeltaInput {
  type: MemoryRowType;
  area_id?: string;
  behavior_id?: string;
  content: string;
  suggested_fix?: string;
  severity?: MemoryRow['severity'];
  /** If updating an existing row, pass its id. */
  id?: string;
  /** Set to true if the current run contradicted an existing row. */
  contradicts?: boolean;
}

/**
 * Merge a batch of reflection-time deltas into the memory file. Returns the
 * updated file. Caller must persist with saveMemory().
 */
export function applyDeltas(file: MemoryFile, runId: string, deltas: DeltaInput[]): MemoryFile {
  const now = new Date().toISOString();
  const byId = new Map(file.rows.map((r) => [r.id, r]));

  for (const d of deltas) {
    const key = d.id && byId.has(d.id) ? d.id : findExisting(file.rows, d);
    if (key && byId.has(key)) {
      const existing = byId.get(key)!;
      if (d.contradicts) {
        existing.contradicted_count += 1;
      } else {
        existing.content = d.content;
        existing.suggested_fix = d.suggested_fix ?? existing.suggested_fix;
        existing.severity = d.severity ?? existing.severity;
        existing.last_confirmed_run_id = runId;
      }
      existing.updated_at = now;
    } else if (!d.contradicts) {
      const row: MemoryRow = {
        id: `mem_${randomUUID().slice(0, 8)}`,
        type: d.type,
        area_id: d.area_id,
        behavior_id: d.behavior_id,
        content: d.content,
        suggested_fix: d.suggested_fix,
        severity: d.severity,
        last_confirmed_run_id: runId,
        contradicted_count: 0,
        created_at: now,
        updated_at: now,
      };
      file.rows.push(row);
      byId.set(row.id, row);
    }
  }

  return file;
}

/**
 * Fuzzy match: same (type, area_id, behavior_id) with similar content.
 * Avoids duplicating rows when the agent re-describes the same fact.
 */
function findExisting(rows: MemoryRow[], d: DeltaInput): string | null {
  for (const r of rows) {
    if (r.type !== d.type) continue;
    if ((r.area_id ?? '') !== (d.area_id ?? '')) continue;
    if ((r.behavior_id ?? '') !== (d.behavior_id ?? '')) continue;
    if (similar(r.content, d.content)) return r.id;
  }
  return null;
}

function similar(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  if (na.length < 20 || nb.length < 20) return false;
  // Trivial overlap check: if one string contains 60% of the other's words.
  const wa = new Set(na.split(/\s+/));
  const wb = nb.split(/\s+/);
  const overlap = wb.filter((w) => wa.has(w)).length / wb.length;
  return overlap >= 0.6;
}
