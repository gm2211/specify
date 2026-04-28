/**
 * src/agent/confidence-store.ts — Per-behavior acceptance rate.
 *
 * Each behavior accumulates a tiny tally of how often the agent's verdict on
 * it was accepted vs overridden by user feedback:
 *
 *   accept    — user agreed (no contradiction, or affirmative kinds:
 *                file_bug + important_pattern reinforce the agent's finding)
 *   override  — user disagreed (missed_check + false_positive +
 *                ignore_pattern correct the agent)
 *
 * The derived `confidence` is `accepts / (accepts + overrides + 1)` (with a
 * +1 prior to keep early-life behaviors below 1.0). The autonomy preset
 * combines confidence with a per-user preset to decide whether the agent
 * should ask before flagging, run silently and report, or skip the check.
 *
 * Storage: `.specify/confidence.json` next to the spec by default. The
 * file is small and human-readable so users can inspect/reset it manually.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { eventBus, type SpecifyEvent } from './event-bus.js';

export type ConfidenceOutcome = 'accept' | 'override';

export interface ConfidenceRow {
  behaviorId: string;
  accepts: number;
  overrides: number;
  lastUpdatedAt: string;
}

export interface ConfidenceFile {
  version: 1;
  rows: Record<string, Omit<ConfidenceRow, 'behaviorId'>>;
}

export type AutonomyPreset = 'ask_everything' | 'ask_uncertain' | 'autonomous';

const FEEDBACK_TO_OUTCOME: Record<string, ConfidenceOutcome | null> = {
  note: null,
  important_pattern: 'accept',
  file_bug: 'accept',
  missed_check: 'override',
  false_positive: 'override',
  ignore_pattern: 'override',
};

export class ConfidenceStore {
  private file: ConfidenceFile;
  private detach: (() => void) | null = null;
  private path: string;

  constructor(filePath: string) {
    this.path = filePath;
    this.file = loadFile(filePath);
  }

  record(behaviorId: string, outcome: ConfidenceOutcome): ConfidenceRow {
    const existing = this.file.rows[behaviorId] ?? { accepts: 0, overrides: 0, lastUpdatedAt: new Date().toISOString() };
    if (outcome === 'accept') existing.accepts += 1;
    else existing.overrides += 1;
    existing.lastUpdatedAt = new Date().toISOString();
    this.file.rows[behaviorId] = existing;
    saveFile(this.path, this.file);
    return { behaviorId, ...existing };
  }

  get(behaviorId: string): ConfidenceRow {
    const row = this.file.rows[behaviorId];
    if (!row) return { behaviorId, accepts: 0, overrides: 0, lastUpdatedAt: '' };
    return { behaviorId, ...row };
  }

  getAll(): ConfidenceRow[] {
    return Object.entries(this.file.rows).map(([behaviorId, row]) => ({ behaviorId, ...row }));
  }

  /** Subscribe this store to feedback:ingested events. Returns unsubscribe. */
  attachToEventBus(): () => void {
    const listener = (e: SpecifyEvent): void => {
      if (e.type !== 'feedback:ingested') return;
      const behaviorId = (e.data?.behaviorId as string | null | undefined) ?? null;
      if (!behaviorId) return;
      const kind = (e.data?.kind as string | undefined) ?? '';
      const outcome = FEEDBACK_TO_OUTCOME[kind];
      if (!outcome) return;
      try {
        this.record(behaviorId, outcome);
      } catch {
        // Persisting confidence is best-effort.
      }
    };
    eventBus.on('event', listener);
    this.detach = () => eventBus.off('event', listener);
    return this.detach;
  }

  close(): void {
    if (this.detach) {
      this.detach();
      this.detach = null;
    }
  }
}

export function confidenceFor(row: ConfidenceRow): number {
  const total = row.accepts + row.overrides;
  if (total === 0) return 0.5; // unknown ⇒ neutral midpoint
  return row.accepts / (row.accepts + row.overrides + 1);
}

export function autonomyDecision(row: ConfidenceRow, preset: AutonomyPreset): 'ask' | 'silent' {
  const c = confidenceFor(row);
  switch (preset) {
    case 'ask_everything':
      return 'ask';
    case 'ask_uncertain':
      return c < 0.7 ? 'ask' : 'silent';
    case 'autonomous':
      return 'silent';
    default:
      return 'ask';
  }
}

export function defaultConfidencePath(specPath: string): string {
  return path.join(path.dirname(path.resolve(specPath)), '.specify', 'confidence.json');
}

function loadFile(filePath: string): ConfidenceFile {
  if (!fs.existsSync(filePath)) return { version: 1, rows: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && raw.version === 1 && raw.rows && typeof raw.rows === 'object') {
      return raw as ConfidenceFile;
    }
  } catch { /* fall through */ }
  return { version: 1, rows: {} };
}

function saveFile(filePath: string, file: ConfidenceFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}
