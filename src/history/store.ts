/**
 * src/history/store.ts — File-based gap report history store
 *
 * Saves and loads gap reports for regression detection and statistical analysis.
 * Reports are stored as JSON files in a configurable directory (default: .specify/history/).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GapReport } from '../validation/types.js';
import type { CliGapReport } from '../cli-test/types.js';

type AnyReport = GapReport | CliGapReport;

export interface HistoryStore {
  dir: string;
  save(report: AnyReport, runId?: string): string;
  load(runId: string): AnyReport;
  list(): string[];
  loadLatest(n: number): AnyReport[];
}

export function createHistoryStore(dir: string): HistoryStore {
  const resolved = path.resolve(dir);

  return {
    dir: resolved,

    save(report: AnyReport, runId?: string): string {
      fs.mkdirSync(resolved, { recursive: true });
      const id = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(resolved, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
      return id;
    },

    load(runId: string): AnyReport {
      const filePath = path.join(resolved, `${runId}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Report not found: ${runId}`);
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AnyReport;
    },

    list(): string[] {
      if (!fs.existsSync(resolved)) return [];
      return fs
        .readdirSync(resolved)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort();
    },

    loadLatest(n: number): AnyReport[] {
      const ids = this.list();
      const latest = ids.slice(-n);
      return latest.map(id => this.load(id));
    },
  };
}
