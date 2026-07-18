/**
 * URL templating — cross-observation segment clustering.
 *
 * Given a corpus of observed URLs (e.g. `/users/1`, `/users/2`,
 * `/users/1/orders/99`), infers a small set of path *templates*
 * (`/users/:id`, `/users/:id/orders/:id2`) that collapse per-entity
 * variation into a stable identity for the state model.
 *
 * This is a foundational piece for the navigation-map / state-abstraction
 * tier: without it, every distinct entity URL becomes its own "state",
 * which explodes combinatorially on any app with per-entity routes.
 *
 * Retrofit opportunity (NOT done in this change — this module ships as a
 * standalone unit; consumers land with the model learner bead):
 *   - src/spec/generator.ts `groupByPage()` currently groups traffic by the
 *     first path segment only (`/api/x/y` -> `/x`), which is far cruder
 *     than template inference and will misgroup per-entity API routes.
 *   - src/agent/capture.ts `slugify()` turns full pathnames (including
 *     entity ids) into filesystem slugs, so `/users/1` and `/users/2`
 *     produce different capture artifacts instead of being recognized as
 *     the same page template.
 *   - src/mock-server.ts indexes recorded traffic by literal
 *     `METHOD pathname`, so mock matching is exact-path only; templating
 *     would let one recorded `/users/1` response serve `/users/:id`.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One segment of a template: either a fixed literal or a named parameter. */
export type TemplateSegment = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

/** A single inferred URL template. */
export interface UrlTemplate {
  /** Template string, e.g. `/users/:id/orders/:id2`. Root path is `/`. */
  template: string;
  /** Ordered segment definitions backing `template`. */
  segments: TemplateSegment[];
  /** Names of parameterized segments, in path order. */
  paramNames: string[];
  /** Number of corpus observations that produced/matched this template. */
  observationCount: number;
}

export interface InferOptions {
  /**
   * A path position is parameterized when more than this many distinct
   * values appear at that position across observations sharing the same
   * segment count, provided sibling positions stay constant. Default 8
   * (i.e. 9+ distinct values triggers parameterization).
   */
  minDistinctForParam?: number;
}

export interface MatchResult {
  template: string;
  params: Record<string, string>;
  /** Query string including leading `?`, or '' if none. Metadata only. */
  query: string;
  /** Hash fragment including leading `#`, or '' if none. Metadata only. */
  hash: string;
}

interface SerializedTemplateSet {
  version: 1;
  opts: Required<InferOptions>;
  sourceUrls: string[];
  templates: UrlTemplate[];
}

const DEFAULT_OPTS: Required<InferOptions> = {
  minDistinctForParam: 8,
};

// ---------------------------------------------------------------------------
// URL parsing / normalization
// ---------------------------------------------------------------------------

interface ParsedUrl {
  path: string;
  query: string;
  hash: string;
  segments: string[];
}

/**
 * Parse a URL (absolute or path-only) into a normalized path plus query/hash
 * metadata. Trailing slashes are normalized away (except the root path);
 * an empty path normalizes to `/`.
 */
function parseUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    url = new URL(raw, 'http://localhost');
  }

  let path = url.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path === '') {
    path = '/';
  }

  const segments = path === '/' ? [] : path.split('/').filter(Boolean);

  return { path, query: url.search, hash: url.hash, segments };
}

// ---------------------------------------------------------------------------
// ID-shape detection
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const HEX_RE = /^[0-9a-f]+$/i;
const ALNUM_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Does this single segment value look like an entity identifier?
 * Covers plain numeric ids, UUIDs, and ulid/base64ish/hex tokens
 * (length >= 8, mixed alphanumeric, or pure hex). Plain English words
 * (e.g. "products") deliberately do not match, even at length >= 8 —
 * they fall back to the distinct-value-count trigger instead.
 */
function looksLikeId(value: string): boolean {
  if (NUMERIC_RE.test(value)) return true;
  if (UUID_RE.test(value)) return true;
  if (value.length >= 8) {
    if (HEX_RE.test(value)) return true;
    if (ALNUM_RE.test(value) && /\d/.test(value) && /[a-zA-Z]/.test(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

interface Observation {
  segments: string[];
}

/**
 * Infer a set of URL templates from a corpus of observed URLs.
 *
 * Algorithm:
 *  1. Parse each URL, dropping query/hash (kept as match()-time metadata).
 *  2. Group observations by segment count.
 *  3. Within each count-group, decide per-position whether it is a
 *     parameter: either every value at that position looks like an id
 *     (numeric/UUID/hex/base64ish token), or more than `minDistinctForParam`
 *     distinct values appear there while sibling (non-param) positions hold
 *     a single constant value. This runs to a small fixed point since
 *     marking one position as a parameter can unblock the sibling-constant
 *     check for another.
 *  4. Render each observation's template string from the resolved parameter
 *     positions, then group by that string — this is the "re-merge" step:
 *     observations that only ever differed at now-parameterized positions
 *     collapse into a single template.
 *
 * Output is sorted by template string, so a shuffled input corpus always
 * produces an identical (order-independent) TemplateSet.
 *
 * Known limitation (v1): locale-prefix segments (2-letter codes like `en`,
 * `fr`) are NOT auto-parameterized — they are indistinguishable from any
 * other short literal segment under this algorithm. A future pass could
 * special-case ISO-639 codes.
 */
export function inferTemplates(urls: string[], opts: InferOptions = {}): TemplateSet {
  const resolvedOpts: Required<InferOptions> = { ...DEFAULT_OPTS, ...opts };
  const templates = buildTemplates(urls, resolvedOpts);
  return new TemplateSet(templates, [...urls], resolvedOpts);
}

function buildTemplates(urls: string[], opts: Required<InferOptions>): UrlTemplate[] {
  const observations: Observation[] = urls.map((u) => ({ segments: parseUrl(u).segments }));

  const byCount = new Map<number, Observation[]>();
  for (const obs of observations) {
    const count = obs.segments.length;
    const bucket = byCount.get(count);
    if (bucket) bucket.push(obs);
    else byCount.set(count, [obs]);
  }

  const templateMap = new Map<string, UrlTemplate>();

  for (const [count, group] of byCount) {
    if (count === 0) {
      // Root path.
      const key = '/';
      const existing = templateMap.get(key);
      if (existing) existing.observationCount += group.length;
      else
        templateMap.set(key, {
          template: '/',
          segments: [],
          paramNames: [],
          observationCount: group.length,
        });
      continue;
    }

    const isParam = resolveParamPositions(group, count, opts);
    const rendered = renderTemplatesForGroup(group, isParam);

    for (const tpl of rendered) {
      const existing = templateMap.get(tpl.template);
      if (existing) existing.observationCount += tpl.observationCount;
      else templateMap.set(tpl.template, tpl);
    }
  }

  return [...templateMap.values()].sort((a, b) => a.template.localeCompare(b.template));
}

/** Distinct values observed at each position across a segment-count group. */
function distinctValuesByPosition(group: Observation[], count: number): Set<string>[] {
  const perPosition: Set<string>[] = Array.from({ length: count }, () => new Set<string>());
  for (const obs of group) {
    for (let i = 0; i < count; i++) {
      perPosition[i].add(obs.segments[i]);
    }
  }
  return perPosition;
}

/** Fixed-point resolution of which positions in a segment-count group are parameters. */
function resolveParamPositions(group: Observation[], count: number, opts: Required<InferOptions>): boolean[] {
  const perPosition = distinctValuesByPosition(group, count);
  const isParam: boolean[] = Array.from({ length: count }, () => false);

  // Pass 1: id-shape — a position parameterizes if every observed value there
  // looks like an id. Order-independent, so a single pass suffices.
  for (let i = 0; i < count; i++) {
    const values = perPosition[i];
    if ([...values].every((value) => looksLikeId(value))) {
      isParam[i] = true;
    }
  }

  // Pass 2: distinct-count trigger, iterated to a fixed point since marking
  // a position as a parameter can free up a previously-blocked sibling.
  let changed = true;
  let iterations = 0;
  while (changed && iterations < count + 1) {
    changed = false;
    iterations++;
    for (let i = 0; i < count; i++) {
      if (isParam[i]) continue;
      const distinctCount = perPosition[i].size;
      if (distinctCount <= opts.minDistinctForParam) continue;

      const siblingsConstant = perPosition.every((values, j) => {
        if (j === i || isParam[j]) return true;
        return values.size === 1;
      });

      if (siblingsConstant) {
        isParam[i] = true;
        changed = true;
      }
    }
  }

  return isParam;
}

/** Render the (possibly several) templates produced by one segment-count group. */
function renderTemplatesForGroup(group: Observation[], isParam: boolean[]): UrlTemplate[] {
  const count = isParam.length;
  const paramNameByPosition = new Map<number, string>();
  let paramIndex = 0;
  for (let i = 0; i < count; i++) {
    if (isParam[i]) {
      paramIndex++;
      paramNameByPosition.set(i, paramIndex === 1 ? 'id' : `id${paramIndex}`);
    }
  }

  const byTemplate = new Map<string, UrlTemplate>();

  for (const obs of group) {
    const segments: TemplateSegment[] = [];
    for (let i = 0; i < count; i++) {
      if (isParam[i]) {
        segments.push({ kind: 'param', name: paramNameByPosition.get(i)! });
      } else {
        segments.push({ kind: 'literal', value: obs.segments[i] });
      }
    }
    const template = '/' + segments.map((s) => (s.kind === 'literal' ? s.value : `:${s.name}`)).join('/');

    const existing = byTemplate.get(template);
    if (existing) {
      existing.observationCount += 1;
    } else {
      byTemplate.set(template, {
        template,
        segments,
        paramNames: segments.filter((s): s is Extract<TemplateSegment, { kind: 'param' }> => s.kind === 'param').map((s) => s.name),
        observationCount: 1,
      });
    }
  }

  return [...byTemplate.values()];
}

// ---------------------------------------------------------------------------
// TemplateSet
// ---------------------------------------------------------------------------

export class TemplateSet {
  private readonly templates: UrlTemplate[];
  private readonly sourceUrls: string[];
  private readonly opts: Required<InferOptions>;

  constructor(templates: UrlTemplate[], sourceUrls: string[], opts: Required<InferOptions> = DEFAULT_OPTS) {
    this.templates = templates;
    this.sourceUrls = sourceUrls;
    this.opts = opts;
  }

  /** All inferred templates, sorted deterministically by template string. */
  list(): UrlTemplate[] {
    return this.templates.map((t) => ({ ...t, segments: [...t.segments], paramNames: [...t.paramNames] }));
  }

  /**
   * Match a URL against the inferred templates. Query string and hash are
   * dropped from matching (returned as metadata); trailing slashes are
   * normalized. Returns null if no template's shape matches.
   */
  match(url: string): MatchResult | null {
    const { segments, query, hash } = parseUrl(url);

    for (const tpl of this.templates) {
      if (tpl.segments.length !== segments.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < tpl.segments.length; i++) {
        const seg = tpl.segments[i];
        const value = segments[i];
        if (seg.kind === 'literal') {
          if (seg.value !== value) {
            ok = false;
            break;
          }
        } else {
          if (value === '') {
            ok = false;
            break;
          }
          params[seg.name] = value;
        }
      }

      if (ok) {
        return { template: tpl.template, params, query, hash };
      }
    }

    return null;
  }

  /** Stable short hash identifying a template string, independent of TemplateSet instance. */
  templateId(template: string): string {
    return createHash('sha256').update(template, 'utf-8').digest('hex').slice(0, 10);
  }

  /**
   * Merge with another TemplateSet by re-inferring over the union of both
   * sets' source URL corpora. Kept intentionally simple (no incremental
   * template surgery) per the bead scope.
   */
  merge(other: TemplateSet): TemplateSet {
    const union = [...this.sourceUrls, ...other.sourceUrls];
    return inferTemplates(union, this.opts);
  }

  toJSON(): SerializedTemplateSet {
    return {
      version: 1,
      opts: { ...this.opts },
      sourceUrls: [...this.sourceUrls],
      templates: this.list(),
    };
  }

  static fromJSON(data: SerializedTemplateSet): TemplateSet {
    if (data.version !== 1) {
      throw new Error(`Unsupported TemplateSet JSON version: ${String((data as { version?: unknown }).version)}`);
    }
    const templates = data.templates.map((t) => ({
      ...t,
      segments: t.segments.map((s) => ({ ...s })),
      paramNames: [...t.paramNames],
    }));
    return new TemplateSet(templates, [...data.sourceUrls], { ...data.opts });
  }
}
