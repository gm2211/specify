/**
 * src/agent/memory-layers.ts — Three-layer prompt context the verify agent
 * receives at session start.
 *
 *   Layer 1 — User      : `~/.specify/memory.md`
 *                         User-level preferences and patterns that travel
 *                         across every project. Free-form markdown.
 *
 *   Layer 2 — Project   : `<spec_dir>/SPECIFY.md` (preferred), falling back
 *                         to `<repo>/CLAUDE.md` at the project root. Per-
 *                         project guidance that is NOT spec-specific.
 *
 *   Layer 3 — Per-spec  : `<spec_dir>/specify.observations.yaml`
 *                         Derived behaviors / patterns the agent has learned
 *                         from prior sessions and feedback for THIS spec.
 *                         User-owned spec stays clean; observations live
 *                         in a sibling file with explicit provenance.
 *
 * The three layers are merged into a single prompt preamble at session
 * start. Sources missing from disk are silently skipped — none of them are
 * mandatory.
 *
 * Observations schema (specify.observations.yaml):
 *   version: 1
 *   observations:
 *     - id: obs-abc123
 *       description: "Always check empty state on search bars"
 *       area_id: forms          # optional
 *       behavior_id: search     # optional
 *       source: user_feedback   # user_feedback | mined_pattern | reflection
 *       session_id: ses_xxx     # optional, the session that produced it
 *       created_at: "2026-04-27T10:00:00Z"
 *       confidence: 0.7         # 0..1, optional
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export type ObservationSource = 'user_feedback' | 'mined_pattern' | 'reflection' | string;

export interface Observation {
  id: string;
  description: string;
  area_id?: string;
  behavior_id?: string;
  source?: ObservationSource;
  session_id?: string;
  created_at?: string;
  confidence?: number;
}

export interface ObservationsFile {
  version: 1;
  observations: Observation[];
}

export interface LayeredContext {
  user?: string;
  project?: string;
  observations: Observation[];
}

export interface LayerLoadOptions {
  /** Override the user-layer file. Default: ~/.specify/memory.md */
  userPath?: string;
  /** Override the project-layer file. Default: <spec_dir>/SPECIFY.md or <repo>/CLAUDE.md */
  projectPath?: string;
  /** Override the per-spec observations file. Default: <spec_dir>/specify.observations.yaml */
  observationsPath?: string;
}

export function defaultUserMemoryPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return path.join(home, '.specify', 'memory.md');
}

export function defaultProjectMemoryPath(specPath: string): string | null {
  const specDir = path.dirname(path.resolve(specPath));
  const candidates = [
    path.join(specDir, 'SPECIFY.md'),
    path.join(specDir, 'CLAUDE.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function defaultObservationsPath(specPath: string): string {
  const specDir = path.dirname(path.resolve(specPath));
  return path.join(specDir, 'specify.observations.yaml');
}

export function loadObservations(filePath: string): Observation[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Partial<ObservationsFile> | null;
    if (!raw || !Array.isArray(raw.observations)) return [];
    return raw.observations.filter((o): o is Observation => Boolean(o && typeof o === 'object' && o.id && o.description));
  } catch {
    return [];
  }
}

export function saveObservations(filePath: string, file: ObservationsFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, yaml.dump(file, { sortKeys: false, lineWidth: 120 }), 'utf-8');
}

export function appendObservation(filePath: string, obs: Observation): ObservationsFile {
  const existing = loadObservations(filePath);
  const next: ObservationsFile = {
    version: 1,
    observations: [...existing, obs],
  };
  saveObservations(filePath, next);
  return next;
}

export function loadLayeredContext(specPath: string, opts: LayerLoadOptions = {}): LayeredContext {
  const userPath = opts.userPath ?? defaultUserMemoryPath();
  const projectPath = opts.projectPath ?? defaultProjectMemoryPath(specPath) ?? '';
  const observationsPath = opts.observationsPath ?? defaultObservationsPath(specPath);

  const out: LayeredContext = { observations: [] };

  if (fs.existsSync(userPath)) {
    const txt = safeReadText(userPath);
    if (txt.trim().length) out.user = txt;
  }
  if (projectPath && fs.existsSync(projectPath)) {
    const txt = safeReadText(projectPath);
    if (txt.trim().length) out.project = txt;
  }
  out.observations = loadObservations(observationsPath);

  return out;
}

/**
 * Render the merged context as a prompt preamble. Sources are stitched in
 * order: user → project → observations. Returns '' when nothing to inject.
 *
 * The output is bounded to keep prompt budgets reasonable; per-section caps
 * apply per layer rather than truncating any single source mid-sentence.
 */
export function renderLayeredPrompt(ctx: LayeredContext, opts: { observationConfidenceFloor?: number; budgetBytes?: number } = {}): string {
  const parts: string[] = [];
  const floor = opts.observationConfidenceFloor ?? 0;

  if (ctx.user) {
    parts.push('## User-level preferences');
    parts.push('');
    parts.push(ctx.user.trim());
    parts.push('');
  }

  if (ctx.project) {
    parts.push('## Project context');
    parts.push('');
    parts.push(ctx.project.trim());
    parts.push('');
  }

  const filtered = ctx.observations.filter((o) => (o.confidence ?? 1) >= floor);
  if (filtered.length) {
    parts.push('## Derived observations for this spec');
    parts.push('');
    parts.push("Soft checks accumulated from prior sessions and user feedback. Treat as");
    parts.push("hints, not contracts: if a live observation contradicts one of these,");
    parts.push("trust the live observation and flag the stale entry.");
    parts.push('');
    for (const o of filtered) {
      const scope = o.behavior_id ? `(${o.area_id ?? '?'}/${o.behavior_id}) ` : o.area_id ? `(${o.area_id}) ` : '';
      const conf = typeof o.confidence === 'number' ? ` [conf ${o.confidence.toFixed(2)}]` : '';
      const src = o.source ? ` <${o.source}>` : '';
      parts.push(`- ${scope}${o.description}${conf}${src}`);
    }
    parts.push('');
  }

  if (!parts.length) return '';
  const out = parts.join('\n');
  const budget = opts.budgetBytes ?? 8 * 1024;
  if (Buffer.byteLength(out, 'utf-8') <= budget) return out;
  // Trim by dropping observations first (most volatile), then project, then user.
  return trimToBudget(parts, budget);
}

function trimToBudget(parts: string[], budget: number): string {
  // Split on markdown H2 headers; drop trailing sections until under budget.
  const sections: string[][] = [];
  let current: string[] = [];
  for (const p of parts) {
    if (p.startsWith('## ') && current.length) {
      sections.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) sections.push(current);

  const flatten = (): string => sections.map((s) => s.join('\n')).join('\n');
  while (sections.length > 1 && Buffer.byteLength(flatten(), 'utf-8') > budget) {
    sections.pop();
  }
  let out = flatten();
  if (Buffer.byteLength(out, 'utf-8') > budget) out = out.slice(0, budget);
  return out;
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
