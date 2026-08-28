/**
 * src/spec/product-context.ts — Deterministic PRODUCT.md / DESIGN.md projection
 *
 * `specify spec context` regenerates PRODUCT.md and DESIGN.md FROM the
 * composed behavioral contract (spec), never the other way around. This
 * module is the pure, deterministic projection step: Spec -> structured
 * context -> Markdown. No LLM call — the spec's own prose and behaviors ARE
 * the content.
 *
 * Two documents, two different jobs:
 *
 *   - PRODUCT.md ("product doctrine"): every area's prose and every
 *     behavior's description, verbatim from the spec. This is strategic
 *     product intent as the spec author wrote it.
 *
 *   - DESIGN.md ("design constraints"): the SUBSET of that same material
 *     that is explicitly tagged as design-relevant (see DESIGN_TAGS below),
 *     plus an optional, clearly-separated section of visual tokens
 *     extracted from code (src/spec/design-tokens.ts). Spec-derived and
 *     code-derived content are never merged into one claim — each token and
 *     each constraint is labeled with where it came from.
 *
 * Traceability: every claim carries an `anchor` — the fully-qualified
 * `area-id` or `area-id/behavior-id` it was extracted from — rendered
 * inline as `[area/behavior]`. Nothing in either document is asserted
 * without a source id. Areas/behaviors with no prose or no matching tag are
 * simply omitted, never backfilled with invented text.
 */

import type { Spec, Area } from './types.js';
import type { DesignTokenExtraction } from './design-tokens.js';

// ---------------------------------------------------------------------------
// Structured projection
// ---------------------------------------------------------------------------

export interface ProductClaim {
  /** Verbatim text from the spec (area prose or behavior description). */
  text: string;
  /** Fully-qualified source id: "area-id" (prose) or "area-id/behavior-id" (behavior). */
  anchor: string;
}

export interface ProductAreaSection {
  areaId: string;
  areaName: string;
  /** The area's own prose claim, present only when the area has non-empty prose. */
  proseClaim?: ProductClaim;
  /** One claim per behavior in the area (or per matching behavior, for design context). */
  behaviorClaims: ProductClaim[];
}

export interface ProductContext {
  specName: string;
  specVersion: string;
  specDescription?: string;
  areas: ProductAreaSection[];
}

/** Tags that mark a behavior as design-relevant for DESIGN.md's spec-derived section. Case-insensitive. */
export const DESIGN_TAGS: ReadonlySet<string> = new Set([
  'design', 'ui', 'ux', 'visual', 'accessibility', 'a11y', 'style', 'layout', 'branding', 'theme',
]);

/** Project the full spec into product-doctrine claims (PRODUCT.md source data). No filtering — every area and behavior is included. */
export function buildProductContext(spec: Spec): ProductContext {
  return {
    specName: spec.name,
    specVersion: spec.version,
    specDescription: spec.description?.trim() || undefined,
    areas: spec.areas.map((area) => areaSection(area, area.behaviors)),
  };
}

export interface DesignContext {
  specName: string;
  /** Areas that have at least one design-tagged behavior, carrying only those behaviors (and the area's prose, for context). */
  constraintAreas: ProductAreaSection[];
  /** Present only when at least one token was found in code. Omitted, never empty-with-a-note, when extraction found nothing. */
  tokens?: DesignTokenExtraction;
}

/** Project the spec into design-relevant claims plus (optionally) extracted code tokens. Areas/behaviors with no design tag are omitted — never fabricated. */
export function buildDesignContext(spec: Spec, tokenExtraction?: DesignTokenExtraction): DesignContext {
  const constraintAreas: ProductAreaSection[] = [];
  for (const area of spec.areas) {
    const matching = area.behaviors.filter((b) => hasDesignTag(b.tags));
    if (matching.length === 0) continue;
    constraintAreas.push(areaSection(area, matching));
  }
  const tokens = tokenExtraction && tokenExtraction.tokens.length > 0 ? tokenExtraction : undefined;
  return { specName: spec.name, constraintAreas, tokens };
}

function hasDesignTag(tags: string[] | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => DESIGN_TAGS.has(t.toLowerCase()));
}

function areaSection(area: Area, behaviors: Area['behaviors']): ProductAreaSection {
  return {
    areaId: area.id,
    areaName: area.name,
    proseClaim: area.prose?.trim() ? { text: area.prose.trim(), anchor: area.id } : undefined,
    behaviorClaims: behaviors.map((b) => ({ text: b.description.trim(), anchor: `${area.id}/${b.id}` })),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function claimLine(claim: ProductClaim, prefix: string): string {
  return `${prefix}${claim.text} [${claim.anchor}]`;
}

/** Render PRODUCT.md's managed-region body (the content between the markers, not the surrounding file). */
export function renderProductMarkdown(ctx: ProductContext, specSourceLabel: string): string {
  const lines: string[] = [];
  lines.push(
    `_Generated by \`specify spec context\` from ${specSourceLabel}. Each claim below is traced to its source with an inline ` +
    '`[area/behavior]` anchor. This region is regenerated on every run — edit outside it, or edit the spec source, for changes ' +
    'that persist._',
  );
  lines.push('');

  if (ctx.specDescription) {
    lines.push('## Overview');
    lines.push('');
    lines.push(ctx.specDescription);
    lines.push('');
  }

  if (ctx.areas.length === 0) {
    lines.push('_No areas defined in the spec._');
    lines.push('');
  }

  for (const area of ctx.areas) {
    lines.push(`## ${area.areaName}`);
    lines.push('');
    if (area.proseClaim) {
      lines.push(claimLine(area.proseClaim, ''));
      lines.push('');
    }
    if (area.behaviorClaims.length > 0) {
      for (const claim of area.behaviorClaims) {
        lines.push(claimLine(claim, '- '));
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/** Render DESIGN.md's managed-region body. */
export function renderDesignMarkdown(ctx: DesignContext, specSourceLabel: string): string {
  const lines: string[] = [];
  lines.push(
    `_Generated by \`specify spec context\` from ${specSourceLabel}. Two independent sources, kept separate: spec-derived ` +
    'product constraints (behaviors tagged ' +
    [...DESIGN_TAGS].map((t) => `\`${t}\``).join(', ') +
    ') below, and (optionally) visual tokens extracted from code. Neither section invents a value absent from its source ' +
    '— an empty source means an omitted or explicitly-noted-empty section, never a guess._',
  );
  lines.push('');

  lines.push('## Product Constraints (from spec)');
  lines.push('');
  if (ctx.constraintAreas.length === 0) {
    lines.push(
      '_No behaviors in the spec are tagged as design-relevant ' +
      `(${[...DESIGN_TAGS].map((t) => `\`${t}\``).join(', ')}). Add one of these tags to a behavior to surface it here._`,
    );
    lines.push('');
  } else {
    for (const area of ctx.constraintAreas) {
      lines.push(`### ${area.areaName}`);
      lines.push('');
      if (area.proseClaim) {
        lines.push(claimLine(area.proseClaim, ''));
        lines.push('');
      }
      for (const claim of area.behaviorClaims) {
        lines.push(claimLine(claim, '- '));
      }
      lines.push('');
    }
  }

  lines.push('## Visual Tokens (from code)');
  lines.push('');
  if (!ctx.tokens || ctx.tokens.tokens.length === 0) {
    lines.push('_No design-token sources found (looked for `design-tokens.json`, `tokens.json`, and CSS custom properties)._');
    lines.push('');
  } else {
    const byCategory = new Map<string, typeof ctx.tokens.tokens>();
    for (const token of ctx.tokens.tokens) {
      const list = byCategory.get(token.category) ?? [];
      list.push(token);
      byCategory.set(token.category, list);
    }
    for (const [category, tokens] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${category[0].toUpperCase()}${category.slice(1)}`);
      lines.push('');
      for (const token of tokens) {
        lines.push(`- \`${token.name}\`: \`${token.value}\` _(source: ${token.source})_`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}
