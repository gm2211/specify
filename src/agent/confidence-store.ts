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
import { specRootDir } from '../spec/paths.js';

export type ConfidenceOutcome = 'accept' | 'override';

export interface ConfidenceRow {
  behaviorId: string;
  accepts: number;
  overrides: number;
  lastUpdatedAt: string;
  /**
   * Running count of consecutive scripted/agent cross-check disagreements
   * for this behavior (SP-bjr). Reset to 0 on any agreement. Not persisted
   * as part of the accept/override tally by itself — see
   * `recordFromCrossCheck`.
   */
  consecutiveMismatches?: number;
}

export interface ConfidenceFile {
  version: 1;
  rows: Record<string, Omit<ConfidenceRow, 'behaviorId'>>;
}

export type AutonomyPreset = 'ask_everything' | 'ask_uncertain' | 'autonomous';

/**
 * Confidence cutoff used by the `ask_uncertain` autonomy preset (below this,
 * the agent asks before acting) and, identically, by the technique selector
 * (src/agent/technique-selector.ts) as the minimum confidence required to
 * route a behavior to the cheap scripted tier. Shared rather than duplicated
 * so the two policies can't silently drift apart.
 */
export const ASK_UNCERTAIN_CONFIDENCE_THRESHOLD = 0.7;

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

  /**
   * Rewrite a row's key after a behavior id rename, preserving accepts/overrides.
   *
   * Rows are keyed by whatever string was passed to record() at write time,
   * which in practice is either the bare behavior id or the fully-qualified
   * "area/behavior" id. To match either convention, this looks for an exact
   * match on `oldId` first, then falls back to matching the bare behavior id
   * (the segment after the last "/", or `oldId` itself if it has no "/").
   * The replacement key mirrors whichever convention was found: a bare match
   * is renamed to the bare segment of `newId`, an exact match is renamed to
   * `newId` verbatim.
   *
   * No-op (returns migrated: false) when no matching row exists.
   */
  rename(oldId: string, newId: string): { migrated: boolean; from: string; to: string } {
    const oldBare = oldId.includes('/') ? oldId.slice(oldId.lastIndexOf('/') + 1) : oldId;
    const newBare = newId.includes('/') ? newId.slice(newId.lastIndexOf('/') + 1) : newId;

    let matchedKey: string | null = null;
    if (Object.prototype.hasOwnProperty.call(this.file.rows, oldId)) {
      matchedKey = oldId;
    } else if (Object.prototype.hasOwnProperty.call(this.file.rows, oldBare)) {
      matchedKey = oldBare;
    }

    if (!matchedKey) return { migrated: false, from: oldId, to: newId };

    const newKey = matchedKey === oldId ? newId : newBare;
    const row = this.file.rows[matchedKey];
    delete this.file.rows[matchedKey];
    this.file.rows[newKey] = row;
    saveFile(this.path, this.file);
    return { migrated: true, from: matchedKey, to: newKey };
  }

  /**
   * Records a scripted/agent cross-check outcome for a behavior (SP-bjr). A
   * single mismatch is expected noise — regenerated or stale tests disagree
   * with the agent routinely during normal development. Only REPEATED (2+
   * consecutive) mismatches are treated as an override-equivalent signal:
   * a test that keeps disagreeing with the agent is more likely pointing at
   * something real than at agent flakiness. Any agreement resets the streak.
   */
  recordFromCrossCheck(behaviorId: string, agreement: boolean): ConfidenceRow {
    const existing = this.file.rows[behaviorId] ?? {
      accepts: 0,
      overrides: 0,
      lastUpdatedAt: new Date().toISOString(),
      consecutiveMismatches: 0,
    };
    if (agreement) {
      existing.consecutiveMismatches = 0;
    } else {
      const streak = (existing.consecutiveMismatches ?? 0) + 1;
      existing.consecutiveMismatches = streak;
      if (streak >= 2) existing.overrides += 1;
    }
    existing.lastUpdatedAt = new Date().toISOString();
    this.file.rows[behaviorId] = existing;
    saveFile(this.path, this.file);
    return { behaviorId, ...existing };
  }

  /** Subscribe this store to feedback:ingested / crosscheck:result events. Returns unsubscribe. */
  attachToEventBus(): () => void {
    const listener = (e: SpecifyEvent): void => {
      if (e.type === 'crosscheck:result') {
        const behaviorId = (e.data?.id as string | null | undefined) ?? null;
        const agreement = e.data?.agreement;
        if (!behaviorId || typeof agreement !== 'boolean') return;
        try {
          this.recordFromCrossCheck(behaviorId, agreement);
        } catch {
          // Persisting confidence is best-effort.
        }
        return;
      }
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
      return c < ASK_UNCERTAIN_CONFIDENCE_THRESHOLD ? 'ask' : 'silent';
    case 'autonomous':
      return 'silent';
    default:
      return 'ask';
  }
}

export function defaultConfidencePath(specPath: string): string {
  return path.join(specRootDir(specPath), '.specify', 'confidence.json');
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
