/**
 * src/history/store.ts — File-based gap report history store
 *
 * Saves and loads gap reports for regression detection and statistical analysis.
 * Reports are stored as JSON files in a configurable directory (default: .specify/history/).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GapReport } from '../validation/types.js';

export interface HistoryStore {
  dir: string;
  save(report: GapReport, runId?: string): string;
  load(runId: string): GapReport;
  list(): string[];
  loadLatest(n: number): GapReport[];
}

export function createHistoryStore(dir: string): HistoryStore {
  const resolved = path.resolve(dir);

  return {
    dir: resolved,

    save(report: GapReport, runId?: string): string {
      fs.mkdirSync(resolved, { recursive: true });
      const id = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(resolved, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
      return id;
    },

    load(runId: string): GapReport {
      const filePath = path.join(resolved, `${runId}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Report not found: ${runId}`);
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GapReport;
    },

    list(): string[] {
      if (!fs.existsSync(resolved)) return [];
      return fs
        .readdirSync(resolved)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort();
    },

    loadLatest(n: number): GapReport[] {
      const ids = this.list();
      const latest = ids.slice(-n);
      return latest.map(id => this.load(id));
    },
  };
}
