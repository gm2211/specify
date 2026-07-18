/**
 * src/model/endpoint-map.ts — Endpoint semantics mapping (once per target).
 *
 * `.specify/endpoints.json` is a durable, reviewable artifact: for a single
 * target it records, per (method, URL template), a semantic classification —
 * which CRUD operation the endpoint performs, which entity type it touches,
 * where the entity id lives (path parameter vs response/body field), and which
 * writable field can carry a probe marker. Downstream session-guarantee probes
 * (epic SP-jdb) consume this map *deterministically*: the LLM/heuristic
 * inference happens once, a human reviews and corrects it, and probes then
 * read the approved classification without any further model calls.
 *
 * This mirrors the review-gate philosophy of src/spec/formulas.ts: an entry
 * carries a `status` (draft | approved | rejected) and probes should only
 * trust `approved` entries. Where formulas gate pass/fail verdicts, this map
 * gates which endpoints a probe is allowed to invoke and how.
 *
 * Two-stage classification (only the heuristic stage lives here):
 *   1. HEURISTIC baseline — method + URL template shape + response/body shape
 *      map to a candidate operation and entity name (POST /users -> create
 *      user; GET /users/:id -> read; GET /users -> list). This is fully
 *      deterministic and is what `deriveEndpointMap` produces.
 *   2. LLM refinement (out of this module) — resolves ambiguous cases
 *      (`needs_review`) and names entity types more precisely. An LLM pass
 *      writes its result back through the same artifact + merge path, so a
 *      human still reviews the final classification before it is `approved`.
 *
 * Hand-edits survive regeneration: `mergeEndpointMap` keys endpoints by
 * (method, template) identity and lets the existing (possibly human-corrected)
 * classification win, only folding in newly-observed endpoints and refreshing
 * volatile stats. Staleness is detected via URL-template drift: an existing
 * endpoint whose template no longer appears in a fresh inference is flagged
 * `stale` rather than silently dropped.
 *
 * Reuses src/model/url-template.ts for template inference so an app's
 * per-entity routes (`/users/1`, `/users/2`) collapse to one endpoint
 * (`/users/:id`) instead of exploding into one entry per id.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CapturedTraffic } from '../capture/types.js';
import { inferTemplates, type InferOptions } from './url-template.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Semantic CRUD operation an endpoint performs. `other` is the escape hatch
 * for endpoints that don't fit a plain CRUD verb (custom actions, RPC-style
 * POSTs), which always need human review before a probe touches them. */
export type EndpointOperation = 'create' | 'read' | 'update' | 'delete' | 'list' | 'other';

/** Confidence of the heuristic classification. Anything below `high` sets
 * `needs_review` so the reviewer (or LLM refinement pass) looks at it. */
export type Confidence = 'high' | 'medium' | 'low';

/** Review status, mirroring src/spec/formulas.ts. Probes trust `approved`. */
export type EndpointStatus = 'draft' | 'approved' | 'rejected';

/**
 * Where the entity's identity lives for this endpoint.
 *  - `path`: a URL template parameter carries the id (`/users/:id` -> `id`).
 *  - `body`: the id is a field of the request/response body (create returns
 *    the freshly-minted id there).
 *  - `none`: no single entity id (list/collection endpoints).
 */
export type IdLocation =
  | { kind: 'path'; param: string }
  | { kind: 'body'; field: string }
  | { kind: 'none' };

/** Why an existing endpoint entry is considered stale on the latest run. */
export type StaleReason = 'template-drift' | 'not-observed';

/** Provenance of a generated map, mirroring src/spec/formulas.ts. */
export interface EndpointMapProvenance {
  generated_by: string;
  model?: string;
  session_id?: string;
  generated_at: string;
}

/** The heuristic output for a single (method, template) endpoint. */
export interface EndpointClassification {
  entity: string;
  operation: EndpointOperation;
  idLocation: IdLocation;
  /** Writable field that can carry a probe marker, or null if none found. */
  markerField: string | null;
  confidence: Confidence;
  /** Human-readable justification for the classification. */
  rationale: string;
}

/** One endpoint entry in the artifact. */
export interface EndpointEntry extends EndpointClassification {
  /** Stable, content-derived id: `ep-<hash6>` of `METHOD template`. */
  id: string;
  /** Uppercased HTTP method. */
  method: string;
  /** URL template, e.g. `/users/:id`. */
  template: string;
  status: EndpointStatus;
  /** True when the classification warrants human/LLM review (confidence < high). */
  needs_review: boolean;
  /** Number of captured requests that matched this endpoint. */
  observationCount: number;
  /** Up to a few example request URLs, for review context. */
  sampleUrls: string[];
  /** Set when the endpoint was not reaffirmed by the latest generation. */
  stale?: StaleReason;
  provenance: EndpointMapProvenance;
}

export interface EndpointMapFile {
  version: 1;
  /** Optional target key (origin / cli:<binary>) this map was built for. */
  target_key?: string;
  /** Template strings this map was inferred against — the drift baseline. */
  templates: string[];
  endpoints: EndpointEntry[];
}

/** Thrown by loadEndpointMap when the artifact is malformed. Unlike the
 * tolerant memory loader, a broken map that probes would consume must surface
 * loudly rather than degrade to "no endpoints". */
export class EndpointMapLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EndpointMapLoadError';
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function endpointMapPath(specDir: string): string {
  return path.join(specDir, '.specify', 'endpoints.json');
}

// ---------------------------------------------------------------------------
// Heuristic classification
// ---------------------------------------------------------------------------

/** Preferred marker-field names, in priority order: a writable free-text-ish
 * field is the safest place to stamp a probe marker without violating a
 * constraint. */
const MARKER_FIELD_PREFERENCES = ['name', 'title', 'label', 'description', 'text', 'content', 'slug'];

/** Fields that look like server-owned identity/metadata, never a marker. */
const NON_MARKER_FIELD_RE = /^(_?id|uuid|guid|.*_id|created_at|updated_at|createdAt|updatedAt|timestamp|_.*|href|url|self|links?)$/i;

/** Body field names that commonly carry a freshly-minted entity id. */
const ID_FIELD_CANDIDATES = ['id', '_id', 'uuid', 'guid'];

interface EndpointGroup {
  method: string;
  template: string;
  segments: TemplateSetSegmentInfo;
  observationCount: number;
  sampleUrls: string[];
  /** A sample request body (postData), if any request in the group had one. */
  sampleRequestBody: unknown;
  /** A sample response body, if any request in the group had one. */
  sampleResponseBody: unknown;
}

interface TemplateSetSegmentInfo {
  /** Ordered literal/param descriptors parsed from the template string. */
  parts: Array<{ kind: 'literal'; value: string } | { kind: 'param'; name: string }>;
  endsWithParam: boolean;
  lastParamName: string | null;
}

/** Parse a `/users/:id/orders` template string into ordered segment info. */
function parseTemplate(template: string): TemplateSetSegmentInfo {
  const raw = template === '/' ? [] : template.replace(/^\//, '').split('/');
  const parts = raw.map((seg) =>
    seg.startsWith(':') ? ({ kind: 'param', name: seg.slice(1) } as const) : ({ kind: 'literal', value: seg } as const),
  );
  const last = parts[parts.length - 1];
  const endsWithParam = last?.kind === 'param';
  const lastParamName = endsWithParam ? (last as { kind: 'param'; name: string }).name : null;
  return { parts, endsWithParam, lastParamName };
}

/** Singularize a simple English plural resource name. Best-effort only. */
export function singularize(word: string): string {
  const w = word;
  if (/[^aeiou]ies$/i.test(w)) return w.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/i.test(w)) return w.slice(0, -2);
  if (/ss$/i.test(w)) return w;
  if (/s$/i.test(w)) return w.slice(0, -1);
  return w;
}

/** Derive the entity name from a template: the resource literal nearest the
 * terminal (the literal before a trailing param, or the trailing literal),
 * singularized. Falls back to the whole path when no literal exists. */
export function entityFromTemplate(template: string): string {
  const { parts } = parseTemplate(template);
  const literals = parts.filter((p): p is { kind: 'literal'; value: string } => p.kind === 'literal');
  if (literals.length === 0) return template === '/' ? 'root' : 'resource';
  // Walk from the end: the resource is the last literal in the path.
  const resource = literals[literals.length - 1].value;
  return singularize(resource.toLowerCase());
}

/** Shallow-parse a JSON body string/value into an object, or return null. */
function asObject(body: unknown): Record<string, unknown> | null {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  // A create/list response is often an array; unwrap the first element.
  if (Array.isArray(value)) value = value[0];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Pick a writable string field to carry a probe marker, or null. */
export function pickMarkerField(requestBody: unknown): string | null {
  const obj = asObject(requestBody);
  if (!obj) return null;
  const stringKeys = Object.keys(obj).filter((k) => typeof obj[k] === 'string' && !NON_MARKER_FIELD_RE.test(k));
  if (stringKeys.length === 0) return null;
  for (const pref of MARKER_FIELD_PREFERENCES) {
    const hit = stringKeys.find((k) => k.toLowerCase() === pref);
    if (hit) return hit;
  }
  return stringKeys[0];
}

/** Detect which body field carries the entity id (for create responses). */
function pickIdField(responseBody: unknown): string {
  const obj = asObject(responseBody);
  if (obj) {
    for (const cand of ID_FIELD_CANDIDATES) {
      const hit = Object.keys(obj).find((k) => k.toLowerCase() === cand);
      if (hit) return hit;
    }
    // Any *_id field, e.g. user_id.
    const suffixed = Object.keys(obj).find((k) => /_id$/i.test(k));
    if (suffixed) return suffixed;
  }
  return 'id';
}

/**
 * Classify a single endpoint from its method, template, and sample bodies.
 * Pure and deterministic — this is the heuristic baseline stage.
 */
export function classifyEndpoint(
  method: string,
  template: string,
  ctx: { requestBody?: unknown; responseBody?: unknown } = {},
): EndpointClassification {
  const m = method.toUpperCase();
  const seg = parseTemplate(template);
  const entity = entityFromTemplate(template);
  const endsWithParam = seg.endsWithParam;
  const pathId: IdLocation = endsWithParam && seg.lastParamName
    ? { kind: 'path', param: seg.lastParamName }
    : { kind: 'none' };

  let operation: EndpointOperation;
  let confidence: Confidence;
  let rationale: string;
  let idLocation: IdLocation;
  let markerField: string | null = null;

  switch (m) {
    case 'GET':
      if (endsWithParam) {
        operation = 'read';
        confidence = 'high';
        idLocation = pathId;
        rationale = `GET on an item template (${template}) reads a single ${entity} by its path id.`;
      } else {
        operation = 'list';
        confidence = 'high';
        idLocation = { kind: 'none' };
        rationale = `GET on a collection template (${template}) lists ${entity} records.`;
      }
      break;
    case 'POST':
      if (endsWithParam) {
        // POST to an item URL is a custom action, not plain create.
        operation = 'other';
        confidence = 'low';
        idLocation = pathId;
        rationale = `POST on an item template (${template}) is a custom action on a ${entity}; needs review.`;
      } else {
        operation = 'create';
        confidence = 'high';
        idLocation = { kind: 'body', field: pickIdField(ctx.responseBody) };
        markerField = pickMarkerField(ctx.requestBody);
        rationale = `POST on a collection template (${template}) creates a ${entity}; new id returned in the body.`;
      }
      break;
    case 'PUT':
    case 'PATCH':
      if (endsWithParam) {
        operation = 'update';
        confidence = 'high';
        idLocation = pathId;
        markerField = pickMarkerField(ctx.requestBody);
        rationale = `${m} on an item template (${template}) updates a ${entity} identified by its path id.`;
      } else {
        operation = 'update';
        confidence = 'low';
        idLocation = { kind: 'none' };
        markerField = pickMarkerField(ctx.requestBody);
        rationale = `${m} on a collection template (${template}) is an ambiguous bulk/upsert update; needs review.`;
      }
      break;
    case 'DELETE':
      if (endsWithParam) {
        operation = 'delete';
        confidence = 'high';
        idLocation = pathId;
        rationale = `DELETE on an item template (${template}) removes a ${entity} by its path id.`;
      } else {
        operation = 'delete';
        confidence = 'low';
        idLocation = { kind: 'none' };
        rationale = `DELETE on a collection template (${template}) is an ambiguous bulk delete; needs review.`;
      }
      break;
    case 'HEAD':
      operation = 'read';
      confidence = 'medium';
      idLocation = pathId;
      rationale = `HEAD on ${template} fetches ${entity} metadata; treated as a read.`;
      break;
    default:
      operation = 'other';
      confidence = 'low';
      idLocation = pathId;
      rationale = `${m} on ${template} does not map to a plain CRUD verb; needs review.`;
      break;
  }

  return { entity, operation, idLocation, markerField, confidence, rationale };
}

// ---------------------------------------------------------------------------
// Derivation from captured traffic
// ---------------------------------------------------------------------------

export interface DeriveOptions {
  /** Passed through to url-template inference. */
  templateOpts?: InferOptions;
  /** Provenance stamped on generated entries. */
  provenance?: Partial<EndpointMapProvenance>;
  /** Target key recorded on the file. */
  targetKey?: string;
  /** Max example URLs kept per endpoint (default 3). */
  maxSampleUrls?: number;
}

/** Stable endpoint id from method + template. */
export function endpointId(method: string, template: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()} ${template}`, 'utf-8')
    .digest('hex')
    .slice(0, 6);
  return `ep-${hash}`;
}

/**
 * Derive a fresh endpoint map from captured traffic. All entries come out as
 * `draft`. Requests are grouped by (method, inferred URL template); each group
 * is classified by the heuristic above.
 */
export function deriveEndpointMap(traffic: CapturedTraffic[], opts: DeriveOptions = {}): EndpointMapFile {
  const maxSamples = opts.maxSampleUrls ?? 3;
  const templateSet = inferTemplates(
    traffic.map((t) => t.url),
    opts.templateOpts,
  );

  const groups = new Map<string, EndpointGroup>();

  for (const req of traffic) {
    const match = templateSet.match(req.url);
    const template = match ? match.template : safePath(req.url);
    const method = req.method.toUpperCase();
    const key = `${method} ${template}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        method,
        template,
        segments: parseTemplate(template),
        observationCount: 0,
        sampleUrls: [],
        sampleRequestBody: undefined,
        sampleResponseBody: undefined,
      };
      groups.set(key, group);
    }
    group.observationCount += 1;
    if (group.sampleUrls.length < maxSamples && !group.sampleUrls.includes(req.url)) {
      group.sampleUrls.push(req.url);
    }
    if (group.sampleRequestBody === undefined && req.postData) {
      group.sampleRequestBody = req.postData;
    }
    if (group.sampleResponseBody === undefined && req.responseBody) {
      group.sampleResponseBody = req.responseBody;
    }
  }

  const provenance: EndpointMapProvenance = {
    generated_by: opts.provenance?.generated_by ?? 'heuristic',
    generated_at: opts.provenance?.generated_at ?? new Date().toISOString(),
    ...(opts.provenance?.model ? { model: opts.provenance.model } : {}),
    ...(opts.provenance?.session_id ? { session_id: opts.provenance.session_id } : {}),
  };

  const endpoints: EndpointEntry[] = [...groups.values()].map((group) => {
    const classification = classifyEndpoint(group.method, group.template, {
      requestBody: group.sampleRequestBody,
      responseBody: group.sampleResponseBody,
    });
    return {
      id: endpointId(group.method, group.template),
      method: group.method,
      template: group.template,
      ...classification,
      status: 'draft' as EndpointStatus,
      needs_review: classification.confidence !== 'high',
      observationCount: group.observationCount,
      sampleUrls: group.sampleUrls,
      provenance,
    };
  });

  endpoints.sort(compareEndpoints);

  return {
    version: 1,
    ...(opts.targetKey ? { target_key: opts.targetKey } : {}),
    templates: templateSet.list().map((t) => t.template).sort(),
    endpoints,
  };
}

/** Deterministic ordering: by template, then method. */
function compareEndpoints(a: EndpointEntry, b: EndpointEntry): number {
  return a.template.localeCompare(b.template) || a.method.localeCompare(b.method);
}

/** Best-effort pathname for a URL that matched no template. */
function safePath(url: string): string {
  try {
    const u = new URL(url, 'http://localhost');
    return u.pathname || '/';
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Merge (hand-edits survive regeneration) + staleness
// ---------------------------------------------------------------------------

export interface MergeResult {
  file: EndpointMapFile;
  /** Endpoints new in `fresh` and added to the map. */
  added: string[];
  /** Endpoints present in both; existing classification preserved. */
  preserved: string[];
  /** Existing endpoints flagged stale (template drift or not re-observed). */
  drifted: string[];
}

/**
 * Merge a freshly-derived map into an existing (possibly hand-edited) one.
 *
 * Identity is (method, template). Rules:
 *  - Present in both: the EXISTING entry wins for every classification field
 *    and its status — this is what makes hand-edits and approvals survive a
 *    regeneration. Only volatile stats (observationCount, sampleUrls) and the
 *    provenance are refreshed from `fresh`, and any prior `stale` flag clears.
 *  - New in fresh: appended as a draft.
 *  - Only in existing: kept, but flagged `stale`. The reason is
 *    `template-drift` when the endpoint's template is absent from the fresh
 *    template set, otherwise `not-observed` (the template still exists but no
 *    request matched this method this round).
 */
export function mergeEndpointMap(existing: EndpointMapFile, fresh: EndpointMapFile): MergeResult {
  const freshByKey = new Map(fresh.endpoints.map((e) => [`${e.method} ${e.template}`, e]));
  const existingByKey = new Map(existing.endpoints.map((e) => [`${e.method} ${e.template}`, e]));
  const freshTemplates = new Set(fresh.templates);

  const added: string[] = [];
  const preserved: string[] = [];
  const drifted: string[] = [];
  const merged: EndpointEntry[] = [];

  // Existing entries: preserve classification, refresh stats or flag stale.
  for (const entry of existing.endpoints) {
    const key = `${entry.method} ${entry.template}`;
    const fresh0 = freshByKey.get(key);
    if (fresh0) {
      const { stale: _drop, ...rest } = entry;
      void _drop;
      merged.push({
        ...rest,
        observationCount: fresh0.observationCount,
        sampleUrls: fresh0.sampleUrls,
        provenance: fresh0.provenance,
      });
      preserved.push(key);
    } else {
      const reason: StaleReason = freshTemplates.has(entry.template) ? 'not-observed' : 'template-drift';
      merged.push({ ...entry, stale: reason });
      drifted.push(key);
    }
  }

  // Fresh entries not already present: append as drafts.
  for (const entry of fresh.endpoints) {
    const key = `${entry.method} ${entry.template}`;
    if (!existingByKey.has(key)) {
      merged.push(entry);
      added.push(key);
    }
  }

  merged.sort(compareEndpoints);

  const templates = [...new Set([...existing.templates, ...fresh.templates])].sort();

  return {
    file: {
      version: 1,
      ...(fresh.target_key ?? existing.target_key ? { target_key: fresh.target_key ?? existing.target_key } : {}),
      templates,
      endpoints: merged,
    },
    added,
    preserved,
    drifted,
  };
}

/**
 * Regenerate the map for a target and merge it over any existing artifact,
 * so a fresh capture updates stats and adds new endpoints without clobbering
 * human corrections. Returns the merged file plus the merge report.
 */
export function regenerateEndpointMap(
  existing: EndpointMapFile | null,
  traffic: CapturedTraffic[],
  opts: DeriveOptions = {},
): MergeResult {
  const fresh = deriveEndpointMap(traffic, opts);
  if (!existing) {
    return {
      file: fresh,
      added: fresh.endpoints.map((e) => `${e.method} ${e.template}`),
      preserved: [],
      drifted: [],
    };
  }
  return mergeEndpointMap(existing, fresh);
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export function emptyEndpointMapFile(targetKey?: string): EndpointMapFile {
  return { version: 1, ...(targetKey ? { target_key: targetKey } : {}), templates: [], endpoints: [] };
}

export function findEndpoint(file: EndpointMapFile, method: string, template: string): EndpointEntry | undefined {
  const m = method.toUpperCase();
  return file.endpoints.find((e) => e.method === m && e.template === template);
}

/** Endpoints a probe may trust: approved and not stale. */
export function approvedEndpoints(file: EndpointMapFile): EndpointEntry[] {
  return file.endpoints.filter((e) => e.status === 'approved' && !e.stale);
}

/** Set the review status of an endpoint by id. Throws if none matches. */
export function setEndpointStatus(file: EndpointMapFile, id: string, status: EndpointStatus): EndpointMapFile {
  const idx = file.endpoints.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No endpoint with id "${id}"`);
  const endpoints = file.endpoints.slice();
  endpoints[idx] = { ...endpoints[idx], status };
  return { ...file, endpoints };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const VALID_OPERATIONS: EndpointOperation[] = ['create', 'read', 'update', 'delete', 'list', 'other'];
const VALID_STATUSES: EndpointStatus[] = ['draft', 'approved', 'rejected'];
const VALID_CONFIDENCE: Confidence[] = ['high', 'medium', 'low'];

/**
 * Load `.specify/endpoints.json`. Returns null when the file does not exist
 * (a legitimate "not mapped yet" state). THROWS EndpointMapLoadError on any
 * malformed content — probes consume this map, so a broken file must surface
 * rather than degrade to "no endpoints".
 */
export function loadEndpointMap(filePath: string): EndpointMapFile | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new EndpointMapLoadError(`Failed to parse ${filePath} as JSON: ${(err as Error).message}`, filePath, err);
  }
  if (!raw || typeof raw !== 'object') {
    throw new EndpointMapLoadError(`${filePath} must contain a JSON object`, filePath);
  }
  const data = raw as Record<string, unknown>;
  if (data.version !== 1) {
    throw new EndpointMapLoadError(`${filePath} has unsupported version "${String(data.version)}" (expected 1)`, filePath);
  }
  if (!Array.isArray(data.endpoints)) {
    throw new EndpointMapLoadError(`${filePath} is missing an "endpoints" array`, filePath);
  }
  const templates = Array.isArray(data.templates)
    ? data.templates.filter((t): t is string => typeof t === 'string')
    : [];

  const endpoints = data.endpoints.map((e, i) => validateEntry(e, i, filePath));

  return {
    version: 1,
    ...(typeof data.target_key === 'string' ? { target_key: data.target_key } : {}),
    templates,
    endpoints,
  };
}

function validateEntry(raw: unknown, index: number, filePath: string): EndpointEntry {
  if (!raw || typeof raw !== 'object') {
    throw new EndpointMapLoadError(`Endpoint at index ${index} is not an object`, filePath);
  }
  const e = raw as Record<string, unknown>;
  const id = assertString(e.id, 'id', filePath);
  const method = assertString(e.method, 'method', filePath).toUpperCase();
  const template = assertString(e.template, 'template', filePath);
  const entity = assertString(e.entity, 'entity', filePath);

  const operation = e.operation;
  if (typeof operation !== 'string' || !VALID_OPERATIONS.includes(operation as EndpointOperation)) {
    throw new EndpointMapLoadError(`Endpoint "${id}" has invalid operation "${String(operation)}"`, filePath);
  }
  const status = e.status;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as EndpointStatus)) {
    throw new EndpointMapLoadError(`Endpoint "${id}" has invalid status "${String(status)}"`, filePath);
  }
  const confidence = e.confidence;
  if (typeof confidence !== 'string' || !VALID_CONFIDENCE.includes(confidence as Confidence)) {
    throw new EndpointMapLoadError(`Endpoint "${id}" has invalid confidence "${String(confidence)}"`, filePath);
  }

  const idLocation = validateIdLocation(e.idLocation, id, filePath);

  const provRaw = e.provenance;
  if (!provRaw || typeof provRaw !== 'object') {
    throw new EndpointMapLoadError(`Endpoint "${id}" is missing "provenance"`, filePath);
  }
  const prov = provRaw as Record<string, unknown>;
  const provenance: EndpointMapProvenance = {
    generated_by: assertString(prov.generated_by, 'provenance.generated_by', filePath),
    generated_at: assertString(prov.generated_at, 'provenance.generated_at', filePath),
    ...(typeof prov.model === 'string' ? { model: prov.model } : {}),
    ...(typeof prov.session_id === 'string' ? { session_id: prov.session_id } : {}),
  };

  const markerField = e.markerField === null || e.markerField === undefined
    ? null
    : typeof e.markerField === 'string'
      ? e.markerField
      : null;

  let stale: StaleReason | undefined;
  if (e.stale !== undefined) {
    if (e.stale !== 'template-drift' && e.stale !== 'not-observed') {
      throw new EndpointMapLoadError(`Endpoint "${id}" has invalid stale reason "${String(e.stale)}"`, filePath);
    }
    stale = e.stale;
  }

  return {
    id,
    method,
    template,
    entity,
    operation: operation as EndpointOperation,
    idLocation,
    markerField,
    confidence: confidence as Confidence,
    rationale: typeof e.rationale === 'string' ? e.rationale : '',
    status: status as EndpointStatus,
    needs_review: e.needs_review === true,
    observationCount: typeof e.observationCount === 'number' ? e.observationCount : 0,
    sampleUrls: Array.isArray(e.sampleUrls) ? e.sampleUrls.filter((u): u is string => typeof u === 'string') : [],
    ...(stale !== undefined ? { stale } : {}),
    provenance,
  };
}

function validateIdLocation(raw: unknown, id: string, filePath: string): IdLocation {
  if (!raw || typeof raw !== 'object') {
    throw new EndpointMapLoadError(`Endpoint "${id}" has missing/invalid idLocation`, filePath);
  }
  const loc = raw as Record<string, unknown>;
  switch (loc.kind) {
    case 'path':
      return { kind: 'path', param: assertString(loc.param, 'idLocation.param', filePath) };
    case 'body':
      return { kind: 'body', field: assertString(loc.field, 'idLocation.field', filePath) };
    case 'none':
      return { kind: 'none' };
    default:
      throw new EndpointMapLoadError(`Endpoint "${id}" has invalid idLocation.kind "${String(loc.kind)}"`, filePath);
  }
}

function assertString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EndpointMapLoadError(`Endpoint entry missing required field "${field}"`, filePath);
  }
  return value;
}

/**
 * Save `.specify/endpoints.json` atomically (tmp + rename) with a stable
 * field order per entry so diffs stay reviewable.
 */
export function saveEndpointMap(filePath: string, file: EndpointMapFile): void {
  const ordered = {
    version: file.version,
    ...(file.target_key ? { target_key: file.target_key } : {}),
    templates: [...file.templates].sort(),
    endpoints: file.endpoints.map((e) => orderEntry(e)),
  };
  const body = JSON.stringify(ordered, null, 2) + '\n';

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function orderEntry(e: EndpointEntry): Record<string, unknown> {
  return {
    id: e.id,
    method: e.method,
    template: e.template,
    entity: e.entity,
    operation: e.operation,
    idLocation: e.idLocation,
    markerField: e.markerField,
    confidence: e.confidence,
    status: e.status,
    needs_review: e.needs_review,
    ...(e.stale !== undefined ? { stale: e.stale } : {}),
    observationCount: e.observationCount,
    sampleUrls: e.sampleUrls,
    rationale: e.rationale,
    provenance: {
      generated_by: e.provenance.generated_by,
      ...(e.provenance.model !== undefined ? { model: e.provenance.model } : {}),
      ...(e.provenance.session_id !== undefined ? { session_id: e.provenance.session_id } : {}),
      generated_at: e.provenance.generated_at,
    },
  };
}
