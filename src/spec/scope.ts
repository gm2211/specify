/**
 * src/spec/scope.ts — Shared spec-scoping and result-merging helpers.
 *
 * Extracted out of src/review/server.ts's inline scoped-verify logic
 * (single-behavior scope + mergeScopedResult) so the CLI's auto-mode
 * verify tier (SP-bjr) can build a scoped spec containing an arbitrary
 * set of behaviors — not just one — without duplicating the filtering
 * and merge logic. The review server keeps its own single-behavior
 * variant; this is the general n-behavior version.
 */

import type { BehaviorResult, Spec } from './types.js';

/**
 * Returns a copy of `spec` containing only the areas/behaviors whose
 * fully-qualified id ("area-id/behavior-id") is in `ids`. Areas left with
 * no matching behaviors are dropped entirely.
 */
export function scopedSpec(spec: Spec, ids: readonly string[]): Spec {
  const idSet = new Set(ids);
  const areas = (spec.areas ?? [])
    .map((area) => ({
      ...area,
      behaviors: (area.behaviors ?? []).filter((b) => idSet.has(`${area.id}/${b.id}`)),
    }))
    .filter((area) => area.behaviors.length > 0);
  return { ...spec, areas };
}

/**
 * Merges `overrides` on top of `base`, keyed by BehaviorResult.id.
 * An override for an id present in `base` replaces it; overrides for ids
 * not in `base` are appended. Order follows `base` first, then any new ids
 * from `overrides` in their original order.
 */
export function mergeResultsById(base: BehaviorResult[], overrides: BehaviorResult[]): BehaviorResult[] {
  const byId = new Map<string, BehaviorResult>(base.map((r) => [r.id, r]));
  for (const r of overrides) byId.set(r.id, r);
  return [...byId.values()];
}
