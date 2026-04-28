/**
 * src/agent/prompt-evolution.ts — Periodic prompt-evolution loop.
 *
 * Two evolvers ship in this module:
 *
 *   1. heuristic — pure-text, deterministic. Folds high-confidence
 *                  observations and frequently-overridden behaviors into
 *                  a system prompt as a "lessons learned" preamble.
 *                  No external dependency. Safe to run on every save.
 *
 *   2. external  — shells out to scripts/evolve-prompt.py (if present),
 *                  which is the integration point for DSPy / GEPA-style
 *                  optimisers. The script receives a JSON corpus on
 *                  stdin and returns a refined prompt on stdout. The
 *                  script is intentionally optional — a clean specify
 *                  install never depends on Python.
 *
 * Outputs land in `.specify/prompts/<id>.md` versioned chronologically
 * so reverts are git-trivial.
 *
 * Corpus assembly is shared by both evolvers: session events from the
 * SQLite/FTS5 store, observations from the per-spec yaml, accept/override
 * stats from the confidence store. The user's confidence preset acts as
 * an importance weight; heavily-overridden behaviors get prominent
 * "remember to check X carefully" lines.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  defaultObservationsPath,
  loadObservations,
  type Observation,
} from './memory-layers.js';
import { ConfidenceStore, defaultConfidencePath, type ConfidenceRow } from './confidence-store.js';
import { defaultSessionDbPath, openSessionStore } from './session-store.js';

export interface EvolveCorpus {
  observations: Observation[];
  confidence: ConfidenceRow[];
  recentSessions: string[];
}

export interface EvolveOptions {
  specPath: string;
  /** Override the prompts directory. Default: <spec_dir>/.specify/prompts */
  promptsDir?: string;
  /** Path to an external optimiser script. Default: scripts/evolve-prompt.py */
  externalScript?: string;
  /** When true, skip the external optimiser even if present. */
  heuristicOnly?: boolean;
  /** Minimum confidence floor to include observations. Default 0.6. */
  observationFloor?: number;
}

export interface EvolveResult {
  /** Path of the new versioned prompt file written to disk. */
  promptPath: string;
  /** Whether the heuristic or external evolver produced the output. */
  source: 'heuristic' | 'external';
  /** The full system prompt text written. */
  prompt: string;
}

export function defaultPromptsDir(specPath: string): string {
  return path.join(path.dirname(path.resolve(specPath)), '.specify', 'prompts');
}

export async function buildCorpus(specPath: string): Promise<EvolveCorpus> {
  const observations = loadObservations(defaultObservationsPath(specPath));
  const confidence = new ConfidenceStore(defaultConfidencePath(specPath)).getAll();
  const store = openSessionStore(defaultSessionDbPath(specPath));
  let recentSessions: string[] = [];
  try {
    recentSessions = store.listSessions({ limit: 10 }).map((s) => s.sessionId);
  } finally {
    store.close();
  }
  return { observations, confidence, recentSessions };
}

export function heuristicEvolve(basePrompt: string, corpus: EvolveCorpus, opts: { observationFloor?: number } = {}): string {
  const floor = opts.observationFloor ?? 0.6;
  const lines: string[] = [];

  const usefulObs = corpus.observations
    .filter((o) => (o.confidence ?? 0) >= floor)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 12);
  if (usefulObs.length) {
    lines.push('## Lessons learned (evolved from feedback)');
    lines.push('');
    for (const o of usefulObs) {
      const scope = o.behavior_id ? `(${o.area_id ?? '?'}/${o.behavior_id}) ` : '';
      lines.push(`- ${scope}${o.description}`);
    }
    lines.push('');
  }

  // Behaviors with low acceptance get a "double-check" reminder.
  const overridden = corpus.confidence
    .filter((c) => c.overrides > c.accepts && c.overrides >= 2)
    .sort((a, b) => b.overrides - a.overrides)
    .slice(0, 6);
  if (overridden.length) {
    lines.push('## Behaviors that have been overridden by the user');
    lines.push('');
    lines.push('Be extra careful when verifying these behaviors. Past runs were corrected here:');
    lines.push('');
    for (const c of overridden) {
      lines.push(`- \`${c.behaviorId}\` (overridden ${c.overrides} times, accepted ${c.accepts}). Re-check the user's prior feedback before flagging.`);
    }
    lines.push('');
  }

  if (!lines.length) return basePrompt;
  return lines.join('\n') + '\n' + basePrompt;
}

/**
 * Run the optional external optimiser script. The script reads a JSON corpus
 * from stdin (`{ basePrompt, observations, confidence, recentSessions }`)
 * and emits a refined prompt on stdout. Stderr is logged but doesn't fail
 * the call. Returns null when the script is missing or exits non-zero.
 */
export async function externalEvolve(basePrompt: string, corpus: EvolveCorpus, scriptPath: string): Promise<string | null> {
  if (!fs.existsSync(scriptPath)) return null;
  return new Promise((resolve) => {
    const proc = spawn(scriptPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) {
        if (stderr) process.stderr.write(`  External evolver exited ${code}: ${stderr.slice(0, 400)}\n`);
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
    proc.stdin.write(JSON.stringify({ basePrompt, ...corpus }));
    proc.stdin.end();
  });
}

export async function evolvePrompt(basePrompt: string, opts: EvolveOptions): Promise<EvolveResult> {
  const corpus = await buildCorpus(opts.specPath);
  const externalScript = opts.externalScript ?? path.resolve(process.cwd(), 'scripts', 'evolve-prompt.py');

  let prompt: string;
  let source: 'heuristic' | 'external';
  if (!opts.heuristicOnly) {
    const refined = await externalEvolve(basePrompt, corpus, externalScript);
    if (refined) {
      prompt = refined;
      source = 'external';
    } else {
      prompt = heuristicEvolve(basePrompt, corpus, { observationFloor: opts.observationFloor });
      source = 'heuristic';
    }
  } else {
    prompt = heuristicEvolve(basePrompt, corpus, { observationFloor: opts.observationFloor });
    source = 'heuristic';
  }

  const promptsDir = opts.promptsDir ?? defaultPromptsDir(opts.specPath);
  fs.mkdirSync(promptsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}_${randomUUID().slice(0, 6)}`;
  const promptPath = path.join(promptsDir, `${id}.md`);
  fs.writeFileSync(promptPath, prompt + '\n', 'utf-8');
  return { promptPath, prompt, source };
}

export function listPromptVersions(specPath: string, promptsDir?: string): Array<{ id: string; filePath: string; createdAt: string }> {
  const dir = promptsDir ?? defaultPromptsDir(specPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const id = f.replace(/\.md$/, '');
      const stat = fs.statSync(path.join(dir, f));
      return { id, filePath: path.join(dir, f), createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
