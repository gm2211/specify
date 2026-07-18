/**
 * src/cli/commands/spec-migrate-id.ts — Rewrite learned-state keys after a
 * behavior/area id rename.
 *
 * Renaming a behavior in the spec silently orphans everything keyed off its
 * old fully-qualified id: confidence.json rows restart at neutral 0.5,
 * observations in specify.observations.yaml stop being surfaced for the
 * renamed behavior, and memory-store playbooks/quirks stop being found. This
 * command rewrites all three stores in place so learned state survives the
 * rename (see `dangling-learned-state` in src/spec/lint.ts for the lint rule
 * that flags drift before this is run).
 *
 * Atomicity: each file is migrated independently via tmp-write + rename (the
 * pattern used by src/daemon/inbox-state.ts), so a crash mid-migration never
 * truncates or corrupts an individual file — it is left either fully old or
 * fully new. This does NOT make the migration atomic across files: a crash
 * between migrating file A and file B leaves A migrated and B not. Re-running
 * the command is safe — it only rewrites rows that still match the old id.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { c } from '../colors.js';
import { specRootDir } from '../../spec/paths.js';
import { ConfidenceStore, defaultConfidencePath } from '../../agent/confidence-store.js';
import { defaultObservationsPath, type Observation, type ObservationsFile } from '../../agent/memory-layers.js';
import type { MemoryFile, MemoryRow } from '../../agent/memory.js';

export interface SpecMigrateIdOptions {
  spec: string;
  oldId: string;
  newId: string;
}

export interface MigrationSummary {
  confidence: { migrated: boolean; from: string; to: string };
  observations: { migrated: number; path: string | null };
  memory: { migrated: number; files: number };
}

function parseFqId(id: string): { areaId: string; behaviorId: string } | null {
  const idx = id.indexOf('/');
  if (idx <= 0 || idx === id.length - 1) return null;
  return { areaId: id.slice(0, idx), behaviorId: id.slice(idx + 1) };
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

function writeYamlAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, yaml.dump(data, { sortKeys: false, lineWidth: 120 }), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function specMigrateId(options: SpecMigrateIdOptions, ctx: CliContext): Promise<number> {
  if (!options.spec) {
    process.stderr.write('Missing --spec (or run from a directory with an auto-discoverable spec)\n');
    return ExitCode.PARSE_ERROR;
  }
  if (!options.oldId || !options.newId) {
    process.stderr.write('Usage: specify spec migrate-id <old-fq-id> <new-fq-id>\n');
    return ExitCode.PARSE_ERROR;
  }

  const oldParsed = parseFqId(options.oldId);
  const newParsed = parseFqId(options.newId);
  if (!oldParsed || !newParsed) {
    process.stderr.write('Both <old-fq-id> and <new-fq-id> must be fully-qualified "area/behavior" ids.\n');
    return ExitCode.PARSE_ERROR;
  }

  const resolvedSpec = path.resolve(options.spec);
  if (!fs.existsSync(resolvedSpec)) {
    process.stderr.write(`Spec source not found: ${resolvedSpec}\n`);
    return ExitCode.PARSE_ERROR;
  }
  const rootDir = specRootDir(resolvedSpec);
  const specifyDir = path.join(rootDir, '.specify');

  const summary: MigrationSummary = {
    confidence: { migrated: false, from: options.oldId, to: options.newId },
    observations: { migrated: 0, path: null },
    memory: { migrated: 0, files: 0 },
  };

  // 1. confidence.json — ConfidenceStore.rename() already does tmp+rename.
  const confidencePath = defaultConfidencePath(resolvedSpec);
  if (fs.existsSync(confidencePath)) {
    const store = new ConfidenceStore(confidencePath);
    summary.confidence = store.rename(options.oldId, options.newId);
  }

  // 2. specify.observations.yaml
  const observationsPath = defaultObservationsPath(resolvedSpec);
  if (fs.existsSync(observationsPath)) {
    summary.observations.path = observationsPath;
    try {
      const raw = yaml.load(fs.readFileSync(observationsPath, 'utf-8')) as Partial<ObservationsFile> | null;
      if (raw && Array.isArray(raw.observations)) {
        let migrated = 0;
        const observations = raw.observations.map((o: Observation) => {
          if (o.area_id === oldParsed.areaId && o.behavior_id === oldParsed.behaviorId) {
            migrated++;
            return { ...o, area_id: newParsed.areaId, behavior_id: newParsed.behaviorId };
          }
          return o;
        });
        if (migrated > 0) {
          writeYamlAtomic(observationsPath, { version: 1, observations });
        }
        summary.observations.migrated = migrated;
      }
    } catch (err) {
      process.stderr.write(`Warning: could not parse ${observationsPath}, skipping: ${(err as Error).message}\n`);
    }
  }

  // 3. .specify/memory/<spec_id>/<target>.json
  const memoryRoot = path.join(specifyDir, 'memory');
  if (fs.existsSync(memoryRoot)) {
    for (const specIdDir of safeReaddir(memoryRoot)) {
      const specIdPath = path.join(memoryRoot, specIdDir);
      if (!safeIsDirectory(specIdPath)) continue;
      for (const file of safeReaddir(specIdPath)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(specIdPath, file);
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MemoryFile;
          if (!raw || !Array.isArray(raw.rows)) continue;
          let migrated = 0;
          const rows = raw.rows.map((r: MemoryRow) => {
            if (r.area_id === oldParsed.areaId && r.behavior_id === oldParsed.behaviorId) {
              migrated++;
              return { ...r, area_id: newParsed.areaId, behavior_id: newParsed.behaviorId };
            }
            return r;
          });
          if (migrated > 0) {
            writeJsonAtomic(filePath, { ...raw, rows });
            summary.memory.migrated += migrated;
            summary.memory.files += 1;
          }
        } catch (err) {
          process.stderr.write(`Warning: could not parse ${filePath}, skipping: ${(err as Error).message}\n`);
        }
      }
    }
  }

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(JSON.stringify({ oldId: options.oldId, newId: options.newId, ...summary }, null, 2) + '\n');
  }

  if (!ctx.quiet) {
    process.stderr.write(`${c.boldGreen('✓ Migrated learned state')} ${options.oldId} → ${options.newId}\n`);
    process.stderr.write(`  ${c.cyan('confidence.json:')} ${summary.confidence.migrated ? '1 row' : '0 rows'}\n`);
    process.stderr.write(`  ${c.cyan('observations:')} ${summary.observations.migrated} row${summary.observations.migrated === 1 ? '' : 's'}\n`);
    process.stderr.write(`  ${c.cyan('memory:')} ${summary.memory.migrated} row${summary.memory.migrated === 1 ? '' : 's'} across ${summary.memory.files} file${summary.memory.files === 1 ? '' : 's'}\n`);
  }

  return ExitCode.SUCCESS;
}
