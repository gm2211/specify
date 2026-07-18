/**
 * src/model/runner-hooks.ts — Runner-integration glue for the navigation map.
 *
 * The pure substrate lives in src/model/nav-model.ts (learner + ModelStore) and
 * src/model/coverage.ts (coverage semantics + exploration hints). This module is
 * the thin, side-effecting bridge that wires that substrate into the live run
 * path, mirroring the shape of src/monitor/verdict-merge.ts:
 *
 *   - POST-RUN (foldRunAndSummarizeCoverage): after a verify run, measure how
 *     much of the ALREADY-LEARNED map this run exercised, THEN fold the run's
 *     observation trace into the persisted per-target model for next time. The
 *     ordering matters — coverage is relative to what was known before this run,
 *     so the model is only updated after coverage is computed (folding first
 *     would make every run trivially cover its own arcs). Returns a compact
 *     summary suitable for embedding in verify-result.json and rendering in the
 *     webapp.
 *
 *   - PRE-RUN (loadExplorationHints / loadExplorationHintsForSpecFile): load the
 *     persisted model and render coverage-directed exploration hints for the
 *     capture/verify prompt. There is no coverage report for a run that has not
 *     happened yet, so hints are ranked purely by cumulative rarity in the map.
 *     Returns '' when no model exists (the first capture of a target is never
 *     steered) or on any error — callers pass the result straight through and
 *     the prompt is left byte-for-byte unchanged.
 *
 * Everything here is gated by navMapCoverageEnabled() so a run is byte-identical
 * to a build with no navigation map when the flag is off.
 */

import * as fs from 'node:fs';
import type { StepObservation } from '../agent/observation.js';
import type { CapturedTraffic } from '../capture/types.js';
import { targetKey, type TargetDescriptor } from '../agent/memory.js';
import { navMapCoverageEnabled } from '../agent/feature-flags.js';
import { specRootDir } from '../spec/paths.js';
import { ModelStore, type SessionTrace } from './nav-model.js';
import {
  computeCoverage,
  explorationHints,
  renderExplorationHints,
  renderCoverageSummary,
  type AxisCoverage,
  type CoverageReport,
} from './coverage.js';

/** One axis of the compact embedded coverage summary (drill-down keys dropped). */
export interface EmbeddedAxisCoverage {
  known: number;
  visited: number;
  ratio: number;
}

/**
 * The navigation-map coverage summary embedded in verify-result.json under
 * `structuredOutput.navMapCoverage` and surfaced in the webapp. Deliberately
 * compact: the full `unvisited` key lists (opaque hashes) stay in the model
 * artifact, not the result JSON.
 */
export interface EmbeddedCoverage {
  /** One-line human summary (renderCoverageSummary). */
  summary: string;
  states: EmbeddedAxisCoverage;
  transitions: EmbeddedAxisCoverage;
  /** True when there was no prior model to measure this run against. */
  empty: boolean;
  /** True when the extractor's predicate keys diverged from the model's. */
  predicateMismatch: boolean;
}

function storeFor(specPath: string, specId: string, key: string): ModelStore {
  return new ModelStore({ specRootDir: specRootDir(specPath), specId, targetKey: key });
}

function targetDescriptor(target: {
  type: 'web' | 'api' | 'cli';
  url?: string;
  binary?: string;
  faultsActive?: boolean;
}): TargetDescriptor {
  return {
    type: target.type,
    ...(target.url !== undefined ? { url: target.url } : {}),
    ...(target.binary !== undefined ? { binary: target.binary } : {}),
    ...(target.faultsActive ? { faultsActive: true } : {}),
  };
}

function emptyReport(specId: string, key: string): CoverageReport {
  const zero: AxisCoverage = { known: 0, visited: 0, ratio: 0, unvisited: [] };
  return {
    specId,
    targetKey: key,
    states: zero,
    transitions: zero,
    empty: true,
    predicateMismatch: false,
  };
}

function toEmbedded(report: CoverageReport): EmbeddedCoverage {
  const axis = (a: AxisCoverage): EmbeddedAxisCoverage => ({
    known: a.known,
    visited: a.visited,
    ratio: a.ratio,
  });
  return {
    summary: renderCoverageSummary(report),
    states: axis(report.states),
    transitions: axis(report.transitions),
    empty: report.empty,
    predicateMismatch: report.predicateMismatch,
  };
}

/**
 * Compute coverage of the EXISTING persisted model by this run, then fold the
 * run's observation trace into the model for subsequent runs. Idempotent by
 * `ref` (re-folding a run already in the model is a no-op). The caller is
 * responsible for the feature-flag gate; this always runs when invoked.
 */
export function foldRunAndSummarizeCoverage(args: {
  specPath: string;
  specId: string;
  target: { type: 'web' | 'api' | 'cli'; url?: string; binary?: string; faultsActive?: boolean };
  /** Stable ref for this run's session (e.g. the runId). */
  ref: string;
  steps: readonly StepObservation[];
  traffic: readonly CapturedTraffic[];
}): EmbeddedCoverage {
  const key = targetKey(targetDescriptor(args.target));
  const store = storeFor(args.specPath, args.specId, key);
  const trace: SessionTrace = {
    ref: args.ref,
    steps: [...args.steps],
    traffic: [...args.traffic],
  };
  const existing = store.load();
  const report = existing ? computeCoverage(existing, [trace]) : emptyReport(args.specId, key);
  // Fold in AFTER measuring, so next run's coverage is against this run too.
  store.update([trace]);
  return toEmbedded(report);
}

/**
 * Render coverage-directed exploration hints from the persisted model for a
 * capture/verify prompt. Self-gates on navMapCoverageEnabled() and returns ''
 * (leaving the prompt unchanged) when the flag is off, no model exists yet, or
 * anything goes wrong — hints are a steering aid, never a correctness input.
 */
export function loadExplorationHints(args: {
  specPath: string;
  specId: string;
  target: { type: 'web' | 'api' | 'cli'; url?: string; binary?: string };
}): string {
  if (!navMapCoverageEnabled()) return '';
  try {
    const key = targetKey(targetDescriptor(args.target));
    const model = storeFor(args.specPath, args.specId, key).load();
    if (!model) return '';
    return renderExplorationHints(explorationHints(model));
  } catch {
    return '';
  }
}

/**
 * Capture-path variant: a capture run has no in-memory spec object, only the
 * path where the (re)generated spec will be written. When that file already
 * exists from a prior run we can resolve the same (spec_id, target) the model
 * was keyed under and steer a re-capture; a first-ever capture has no spec file
 * and no model, so this returns '' and the prompt is unchanged.
 */
export async function loadExplorationHintsForSpecFile(specFilePath: string): Promise<string> {
  if (!navMapCoverageEnabled()) return '';
  try {
    if (!fs.existsSync(specFilePath)) return '';
    const { loadSpec } = await import('../spec/parser.js');
    const spec = loadSpec(specFilePath);
    const t = spec.target as { type: 'web' | 'api' | 'cli'; url?: string; binary?: string };
    return loadExplorationHints({
      specPath: specFilePath,
      specId: spec.name,
      target: { type: t.type, url: t.url, binary: t.binary },
    });
  } catch {
    return '';
  }
}
