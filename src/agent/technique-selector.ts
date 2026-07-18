/**
 * src/agent/technique-selector.ts — Confidence-driven verification routing.
 *
 * `--mode auto` (src/agent/scripted-runner.ts, wired in src/cli/index.ts)
 * used to always run the FULL scripted suite first and escalate whatever
 * failed or was untested. That's cheap on a fresh spec but wasteful on a
 * mature one: SP-bjr's ConfidenceStore already tracks, per behavior, how
 * often the agent's verdict has been accepted vs overridden by user
 * feedback or scripted/agent cross-check disagreement. This module uses
 * that signal (plus on-disk test/last-run state) to decide, PER BEHAVIOR,
 * whether the cheap scripted tier is trustworthy enough to rely on or
 * whether the behavior should go straight to the agent — skipping a
 * scripted attempt that history says is pointless.
 *
 * Policy (see `selectTechnique`): 'scripted' only when confidence is high,
 * a generated test exists, and that test's last recorded run passed.
 * Everything else — low/neutral confidence, no test, a stale/failed last
 * run, or the reserved 'agent-only' tag — routes to 'agent'. Sparse data
 * (no feedback yet) sits at the neutral 0.5 midpoint (see
 * `confidenceFor`), which is below the default threshold, so a fresh spec
 * routes everything to the agent, same as before this module existed.
 * Savings only appear as feedback accumulates and confidence rises.
 *
 * This module makes no state changes of its own — no new confidence math,
 * no new persistence. Demotion after a cross-check mismatch or feedback
 * override already happens in confidence-store.ts; this module just reads
 * the result of that existing math.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ASK_UNCERTAIN_CONFIDENCE_THRESHOLD,
  confidenceFor,
  type ConfidenceRow,
} from './confidence-store.js';
import { escapeRegExp } from './test-runner.js';
import type { BehaviorResult, Spec } from '../spec/types.js';

export type Technique = 'scripted' | 'agent';

/**
 * Reserved behavior tag (spec.areas[].behaviors[].tags) that always forces
 * the agent tier, regardless of confidence or test history — an escape
 * hatch for behaviors a spec author knows scripted replay can't judge
 * (visual/subjective checks, flaky-by-nature flows, etc.).
 */
export const AGENT_ONLY_TAG = 'agent-only';

/** Everything `selectTechnique` needs to decide one behavior's technique. */
export interface TechniqueContext {
  /** The behavior's row from the ConfidenceStore (use `.get(id)`; a missing row is the neutral zero row). */
  confidenceRow: ConfidenceRow;
  /** Whether a generated Playwright test already exists for this behavior in the output dir. */
  testExists: boolean;
  /** mtime (ms since epoch) of the file containing that test, if `testExists`. Reserved for future freshness heuristics — not consulted by the current policy. */
  testMtimeMs?: number;
  /** Status of this behavior in the last verify-result.json written to the output dir, if any. */
  lastStatus?: BehaviorResult['status'];
  /** The behavior's tags from the spec, if any. */
  tags?: string[];
}

export interface SelectTechniqueOptions {
  /** Minimum confidence required to route to 'scripted'. Defaults to `ASK_UNCERTAIN_CONFIDENCE_THRESHOLD` (0.7) — shared with the ask_uncertain autonomy preset rather than duplicated. */
  threshold?: number;
}

/**
 * Decides the cheapest sufficient verification technique for one behavior.
 *
 * 'scripted' requires ALL of:
 *   - confidence >= threshold (default 0.7)
 *   - a generated test exists for this behavior
 *   - the last recorded status for this behavior was 'passed'
 *
 * Anything else — including the reserved 'agent-only' tag, which short-
 * circuits before the above checks — routes to 'agent'.
 */
export function selectTechnique(
  _behaviorFqId: string,
  ctx: TechniqueContext,
  opts: SelectTechniqueOptions = {},
): Technique {
  if (ctx.tags?.includes(AGENT_ONLY_TAG)) return 'agent';

  const threshold = opts.threshold ?? ASK_UNCERTAIN_CONFIDENCE_THRESHOLD;
  const confidence = confidenceFor(ctx.confidenceRow);

  if (confidence >= threshold && ctx.testExists && ctx.lastStatus === 'passed') {
    return 'scripted';
  }
  return 'agent';
}

/**
 * Scans generated Playwright spec files (*.spec.ts / *.spec.js) directly
 * under `outputDir` for a test title beginning with "<behaviorFqId>:" — the
 * same contract `extractBehaviorId` parses at run time. A static text scan
 * rather than an actual playwright run: existence-checking shouldn't cost a
 * process spawn per behavior.
 */
export function findGeneratedTest(outputDir: string, behaviorFqId: string): { exists: boolean; mtimeMs?: number } {
  let files: string[];
  try {
    files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js'));
  } catch {
    return { exists: false };
  }

  const needle = `${behaviorFqId}:`;
  for (const f of files) {
    const full = path.join(outputDir, f);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    if (content.includes(needle)) {
      let mtimeMs: number | undefined;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        // best-effort
      }
      return { exists: true, mtimeMs };
    }
  }
  return { exists: false };
}

/**
 * Reads outputDir/verify-result.json (as written by a prior `specify verify`
 * run, any mode) and returns the last recorded status per behavior id.
 * Absent, unparsable, or malformed files are treated as "no history" — an
 * empty map — never thrown.
 */
export function lastVerifyStatuses(outputDir: string): Map<string, BehaviorResult['status']> {
  const out = new Map<string, BehaviorResult['status']>();
  try {
    const raw = fs.readFileSync(path.join(outputDir, 'verify-result.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { structuredOutput?: { results?: BehaviorResult[] } };
    for (const r of parsed.structuredOutput?.results ?? []) {
      if (r && typeof r.id === 'string' && typeof r.status === 'string') {
        out.set(r.id, r.status);
      }
    }
  } catch {
    // no prior run, or unparsable — treated as no history
  }
  return out;
}

export interface RoutingPartition {
  /** Fully-qualified behavior ids routed to the scripted tier. */
  scripted: string[];
  /** Fully-qualified behavior ids routed to the agent tier. */
  agent: string[];
}

/**
 * Routes EVERY behavior in `spec` to a technique — the partition's two
 * arrays always cover the full set of behavior ids in the spec with no
 * overlap and no gaps, preserving ALL_UNTESTED semantics (a behavior with
 * no generated test still gets routed — to 'agent', never dropped).
 *
 * `getRow` is injected (rather than this function owning a ConfidenceStore)
 * so callers can pass `store.get.bind(store)` in production and a stub in
 * tests.
 */
export function routeBehaviors(
  spec: Spec,
  getRow: (behaviorFqId: string) => ConfidenceRow,
  outputDir: string,
  opts: SelectTechniqueOptions = {},
): RoutingPartition {
  const statuses = lastVerifyStatuses(outputDir);
  const scripted: string[] = [];
  const agent: string[] = [];

  for (const area of spec.areas ?? []) {
    for (const behavior of area.behaviors ?? []) {
      const id = `${area.id}/${behavior.id}`;
      const { exists, mtimeMs } = findGeneratedTest(outputDir, id);
      const ctx: TechniqueContext = {
        confidenceRow: getRow(id),
        testExists: exists,
        testMtimeMs: mtimeMs,
        lastStatus: statuses.get(id),
        tags: behavior.tags,
      };
      const technique = selectTechnique(id, ctx, opts);
      (technique === 'scripted' ? scripted : agent).push(id);
    }
  }

  return { scripted, agent };
}

/**
 * Builds a Playwright `--grep` regex that matches only the generated test
 * titles for `behaviorIds` (via `"<id>: "` alternation), properly escaping
 * each id for literal regex use — mirrors the single-id pattern
 * `confirmBehavior` already uses (`escapeRegExp(\`${behaviorId}:\`)`),
 * generalized to N ids joined with `|`.
 *
 * Returns `undefined` for an empty list — callers should skip running the
 * suite entirely rather than pass an empty/always-matching grep.
 */
export function buildScopedGrep(behaviorIds: readonly string[]): string | undefined {
  if (behaviorIds.length === 0) return undefined;
  return behaviorIds.map((id) => escapeRegExp(`${id}:`)).join('|');
}
