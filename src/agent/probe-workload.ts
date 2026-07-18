/**
 * src/agent/probe-workload.ts — Probe workload generator (epic SP-jdb, Tier 4).
 *
 * WHY
 * ----------------------------------------------------------------------------
 * Passively-captured HTTP traffic cannot support sound consistency checking:
 * there are no transaction boundaries, no unique values to trace a write into
 * a later read, and no bookkeeping for operations whose outcome is unknown
 * (a timeout might have applied or not). This module produces the *designed*
 * workload the checker (SP-qkx) needs: it issues its own marker-tagged CRUD
 * operations against a target and records, per operation, exactly what was
 * sent, what came back, and whether the operation succeeded, failed, or is
 * INDETERMINATE. Those records are the sole input to session-guarantee
 * checking (read-your-writes, monotonic reads, no-resurrection-after-delete,
 * create-appears-in-subsequent-list).
 *
 * WHAT
 * ----------------------------------------------------------------------------
 * For each entity that has an approved `create` endpoint, the generator runs a
 * CRUD sequence:
 *
 *   create  -> read -> list -> update -> read -> delete -> read
 *
 * The create request embeds a fresh UUID marker in the endpoint's writable
 * `markerField`; the id minted in the create response then addresses every
 * subsequent op. Every op is recorded as a ProbeOpRecord (opId, type, entity,
 * marker, invoke/complete timestamps, outcome, request, response). A best-
 * effort cleanup pass deletes any entity the sequence did not already delete,
 * and reports what it could and could not remove.
 *
 * TWO INVARIANTS THIS MODULE IS BUILT AROUND
 * ----------------------------------------------------------------------------
 * 1. ENDPOINT SOURCING. Probes source endpoints EXCLUSIVELY via
 *    `approvedEndpoints()` (src/model/endpoint-map.ts). Draft, rejected, and
 *    stale entries are never invoked against a live target.
 *
 * 2. TIMEOUT = INDETERMINATE, NEVER FAILED. An op whose request times out is
 *    recorded `indeterminate` — it may or may not have applied. The checker
 *    treats it as possibly-applied and concurrent with everything after it.
 *    Only a definite response (any HTTP status) or a definite pre-flight
 *    network error produces `ok`/`fail`.
 *
 * SAFETY
 * ----------------------------------------------------------------------------
 * Probes mutate target state. They run ONLY when the runtime flag is set AND
 * the target opts in (`target.probes.enabled`) AND the target EXPLICITLY
 * declares `production: false` (fail-closed: an absent field refuses, and
 * `production: true` hard-blocks). `assertProbesAllowed` is the single gate;
 * call it before any request is issued.
 *
 * AUTH lives outside this module: callers resolve headers via the existing
 * hooks/variables machinery (src/agent/hooks.ts) and pass the resolved header
 * map in. This module never reads env vars or substitutes variables itself,
 * and — mirroring src/agent/observation.ts — it never records request headers,
 * since they may carry credentials.
 */

import * as crypto from 'node:crypto';
import type { EndpointEntry, EndpointMapFile, IdLocation } from '../model/endpoint-map.js';
import { approvedEndpoints } from '../model/endpoint-map.js';
import type { ApiTarget } from '../spec/types.js';

// ---------------------------------------------------------------------------
// Op vocabulary
// ---------------------------------------------------------------------------

/** The CRUD operation kinds a probe workload issues. */
export type ProbeOpType = 'create' | 'read' | 'list' | 'update' | 'delete';

/**
 * Outcome of a single probe op.
 *  - `ok`: a 2xx response was received.
 *  - `fail`: a definite non-2xx response, or a definite pre-flight network
 *    error (connection refused, DNS failure) that means the request never
 *    reached the server.
 *  - `indeterminate`: the request timed out. It may or may not have applied;
 *    NEVER assume it failed.
 */
export type ProbeOutcome = 'ok' | 'fail' | 'indeterminate';

/**
 * What was sent. Request headers are deliberately NOT recorded — they may
 * carry credentials (mirrors the redaction stance in observation.ts).
 */
export interface ProbeRequestRecord {
  method: string;
  url: string;
  /** Request body actually sent (create/update only), already parsed. */
  body?: unknown;
}

/** What came back. Absent when the op produced no response (timeout/network). */
export interface ProbeResponseRecord {
  status: number;
  /** Response body, parsed as JSON when possible, else the raw (capped) text. */
  body?: unknown;
}

/** One recorded probe operation — the atomic unit the checker consumes. */
export interface ProbeOpRecord {
  /** Stable, run-unique id: `op-0001`, in issue order. */
  opId: string;
  type: ProbeOpType;
  /** Entity type this op concerns (from the endpoint classification). */
  entity: string;
  /**
   * The marker relevant to this op's state: the value written by a
   * create/update, or the value a read/list/delete is expected to observe.
   * Null when the entity had no writable markerField.
   */
  marker: string | null;
  /** ms epoch when the request was issued. */
  invokeTs: number;
  /** ms epoch when the outcome was known (response, timeout, or error). */
  completeTs: number;
  outcome: ProbeOutcome;
  request: ProbeRequestRecord;
  response?: ProbeResponseRecord;
  /** Human-readable error detail for fail/indeterminate outcomes. */
  error?: string;
}

// ---------------------------------------------------------------------------
// HTTP client seam (injectable for tests)
// ---------------------------------------------------------------------------

export interface ProbeHttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Parsed body; the client serializes it (JSON) if present. */
  body?: unknown;
}

export interface ProbeHttpResponse {
  status: number;
  body: unknown;
}

/** Whether a thrown request error was a timeout (indeterminate) or a definite
 * pre-flight network failure (fail). */
export type ProbeHttpErrorKind = 'timeout' | 'network';

/** Error the HTTP client throws when NO response was received. */
export class ProbeHttpError extends Error {
  constructor(
    message: string,
    public readonly kind: ProbeHttpErrorKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProbeHttpError';
  }
}

/**
 * Issue one request. MUST resolve with a ProbeHttpResponse for any received
 * HTTP status (including 4xx/5xx), and MUST reject with a ProbeHttpError
 * (kind `timeout` for aborts/timeouts, `network` for definite pre-flight
 * failures) when no response is received.
 */
export type ProbeHttpClient = (req: ProbeHttpRequest, opts: { timeoutMs: number }) => Promise<ProbeHttpResponse>;

/** Largest response body (in chars) retained on a ProbeResponseRecord. */
const MAX_RESPONSE_BODY_CHARS = 64 * 1024;

/**
 * Default client over global `fetch`. Timeouts/aborts become
 * ProbeHttpError('timeout'); other pre-flight failures become
 * ProbeHttpError('network'). Response bodies are JSON-parsed when possible and
 * capped at MAX_RESPONSE_BODY_CHARS.
 */
export const defaultHttpClient: ProbeHttpClient = async (req, opts) => {
  const headers: Record<string, string> = { ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const kind: ProbeHttpErrorKind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
    throw new ProbeHttpError(err instanceof Error ? err.message : String(err), kind, err);
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    // Body read failed after headers arrived; still a definite response.
  }
  const capped = text.length > MAX_RESPONSE_BODY_CHARS ? text.slice(0, MAX_RESPONSE_BODY_CHARS) : text;
  return { status: res.status, body: parseMaybeJson(capped) };
};

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

function parseMaybeJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/** Prefix on every probe marker, so probe-written values are recognizable in a
 * target's data (and greppable during cleanup). */
export const MARKER_PREFIX = 'specify-probe-';

/** Mint a fresh, globally-unique marker. Accepts an id generator for tests. */
export function newMarker(genId: () => string = () => crypto.randomUUID()): string {
  return `${MARKER_PREFIX}${genId()}`;
}

// ---------------------------------------------------------------------------
// URL templating
// ---------------------------------------------------------------------------

/** Thrown when a template needs a path param the caller did not supply. */
export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/**
 * Render a `/users/:id/orders/:id2` template into a concrete path by
 * substituting `:name` segments from `params`. Throws TemplateRenderError if
 * any param is missing, so a botched substitution is a recorded op failure
 * rather than a request to a malformed URL.
 */
export function renderTemplate(template: string, params: Record<string, string>): string {
  const segments = template === '/' ? [] : template.replace(/^\//, '').split('/');
  const rendered = segments.map((seg) => {
    if (!seg.startsWith(':')) return seg;
    const name = seg.slice(1);
    const value = params[name];
    if (value === undefined) {
      throw new TemplateRenderError(`Template "${template}" needs param ":${name}" but it was not provided`);
    }
    return encodeURIComponent(value);
  });
  return '/' + rendered.join('/');
}

/** Join a base URL and a rendered path into an absolute URL. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Extract the entity id from a value at the given idLocation. Returns null
 * when the field/value is absent or not a scalar. */
export function extractId(body: unknown, idLocation: IdLocation): string | null {
  if (idLocation.kind !== 'body') return null;
  let value = body;
  // Create responses sometimes wrap the entity in an array.
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== 'object') return null;
  const field = (value as Record<string, unknown>)[idLocation.field];
  if (typeof field === 'string') return field;
  if (typeof field === 'number') return String(field);
  return null;
}

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

/** Thrown when a probe run is attempted against a target that has not opted in
 * (or is production-flagged, or the runtime flag is off). */
export class ProbeSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeSafetyError';
  }
}

/**
 * The single gate for state-mutating probes. All of these must hold:
 *  - the run was invoked with `allowProbes: true` (the runtime flag);
 *  - the target opted in via `target.probes.enabled`;
 *  - the target EXPLICITLY declares `production: false`. This is fail-closed:
 *    an absent `production` field refuses, so an unmarked production target
 *    can never be probed by omission — the spec author must consciously
 *    declare the target non-production. `production: true` hard-blocks.
 * Throws ProbeSafetyError otherwise.
 */
export function assertProbesAllowed(target: ApiTarget, opts: { allowProbes: boolean }): void {
  if (!opts.allowProbes) {
    throw new ProbeSafetyError('Probes are disabled for this run (runtime flag not set).');
  }
  if (target.production === true) {
    throw new ProbeSafetyError('Refusing to probe a production-flagged target.');
  }
  if (!target.probes?.enabled) {
    throw new ProbeSafetyError('Target has not opted into probes (set target.probes.enabled).');
  }
  if (target.production === undefined) {
    throw new ProbeSafetyError(
      'Target does not declare "production". Probes mutate state and fail closed: ' +
        'explicitly set production: false (or true) on the target so the declaration is a conscious decision.',
    );
  }
}

// ---------------------------------------------------------------------------
// Workload planning
// ---------------------------------------------------------------------------

/** The endpoints a single entity's CRUD sequence can use. Only `create` is
 * required to run a sequence; the rest are used when present. */
export interface EntityWorkload {
  entity: string;
  create?: EndpointEntry;
  read?: EndpointEntry;
  list?: EndpointEntry;
  update?: EndpointEntry;
  delete?: EndpointEntry;
}

/**
 * Group approved endpoints by entity into per-entity workloads. When several
 * approved endpoints share an entity+operation, the first in canonical order
 * wins (endpoints arrive already sorted from the map). Entities without a
 * `create` endpoint are dropped — there is nothing to write, mark, and trace.
 */
export function planEntityWorkloads(endpoints: EndpointEntry[]): EntityWorkload[] {
  const byEntity = new Map<string, EntityWorkload>();
  for (const ep of endpoints) {
    let wl = byEntity.get(ep.entity);
    if (!wl) {
      wl = { entity: ep.entity };
      byEntity.set(ep.entity, wl);
    }
    switch (ep.operation) {
      case 'create':
        if (!wl.create) wl.create = ep;
        break;
      case 'read':
        if (!wl.read) wl.read = ep;
        break;
      case 'list':
        if (!wl.list) wl.list = ep;
        break;
      case 'update':
        if (!wl.update) wl.update = ep;
        break;
      case 'delete':
        if (!wl.delete) wl.delete = ep;
        break;
      case 'other':
        // Custom actions / RPC-style POSTs are never auto-invoked.
        break;
    }
  }
  return [...byEntity.values()]
    .filter((wl) => wl.create !== undefined)
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

// ---------------------------------------------------------------------------
// Run result types
// ---------------------------------------------------------------------------

/** Per-entity outcome of a CRUD sequence. */
export interface EntityWorkloadResult {
  entity: string;
  /** Id minted by the create op, or null when create failed / returned no id. */
  createdId: string | null;
  /** The create marker (null when the entity had no writable markerField). */
  marker: string | null;
  /** True once a delete op for this entity returned ok. */
  deleted: boolean;
  ops: ProbeOpRecord[];
}

/**
 * One cleanup deletion attempt for an entity the sequence left behind.
 * `skipped-unsafe` means the delete was never issued because the approved
 * delete endpoint's template does not address the entity id (e.g. a
 * collection-level DELETE) — invoking it could hit a broader endpoint.
 */
export interface CleanupAttempt {
  entity: string;
  id: string;
  outcome: ProbeOutcome | 'skipped-unsafe';
  error?: string;
}

export interface CleanupResult {
  attempted: number;
  deleted: number;
  attempts: CleanupAttempt[];
}

/** The complete, self-contained result of a probe run. */
export interface ProbeRunResult {
  /** Every op, in issue order, across all entities (create/read/list/...). */
  ops: ProbeOpRecord[];
  entities: EntityWorkloadResult[];
  /** Distinct markers written during the run. */
  markers: string[];
  cleanup: CleanupResult;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ProbeRunOptions {
  /** Runtime opt-in flag; must be true or the safety gate throws. */
  allowProbes: boolean;
  /** Base URL to resolve endpoint templates against. Defaults to target.url. */
  baseUrl?: string;
  /** Resolved request headers (auth etc.) — resolved by the caller via hooks. */
  headers?: Record<string, string>;
  /** Per-request timeout. Default 10_000ms. */
  timeoutMs?: number;
  /** HTTP client seam. Defaults to `defaultHttpClient`. */
  http?: ProbeHttpClient;
  /** Marker id generator (for deterministic tests). */
  genId?: () => string;
  /** Clock (for deterministic tests). Defaults to Date.now. */
  now?: () => number;
  /** Cap on how many entities to probe (protects against huge maps). */
  maxEntities?: number;
}

/**
 * Run marker-tagged CRUD probes against `target`, sourcing endpoints only from
 * the approved entries of `file`. Returns the complete op log plus cleanup
 * report. Throws ProbeSafetyError (before any request) if the safety gate is
 * not satisfied.
 */
export async function runProbeWorkload(
  file: EndpointMapFile,
  target: ApiTarget,
  opts: ProbeRunOptions,
): Promise<ProbeRunResult> {
  assertProbesAllowed(target, { allowProbes: opts.allowProbes });

  const http = opts.http ?? defaultHttpClient;
  const now = opts.now ?? Date.now;
  const genId = opts.genId;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseUrl = opts.baseUrl ?? target.url;
  const headers = opts.headers ?? target.headers ?? {};

  const workloads = planEntityWorkloads(approvedEndpoints(file));
  const bounded = opts.maxEntities !== undefined ? workloads.slice(0, opts.maxEntities) : workloads;

  const allOps: ProbeOpRecord[] = [];
  const entities: EntityWorkloadResult[] = [];
  const markers = new Set<string>();
  let opSeq = 0;
  const nextOpId = (): string => `op-${String(++opSeq).padStart(4, '0')}`;

  const runOne = async (spec: OpSpec): Promise<ProbeOpRecord> => {
    const record = await executeOp({ opId: nextOpId(), spec, baseUrl, http, now, timeoutMs });
    allOps.push(record);
    return record;
  };

  for (const wl of bounded) {
    const create = wl.create!;
    const marker = create.markerField ? mint(markers, genId) : null;
    const entityResult: EntityWorkloadResult = {
      entity: wl.entity,
      createdId: null,
      marker,
      deleted: false,
      ops: [],
    };

    // 1. CREATE
    const createBody = create.markerField && marker ? { [create.markerField]: marker } : {};
    const createRec = await runOne({
      type: 'create',
      entity: wl.entity,
      marker,
      method: create.method,
      template: create.template,
      params: {},
      headers,
      body: createBody,
    });
    entityResult.ops.push(createRec);

    if (createRec.outcome === 'ok') {
      entityResult.createdId = extractId(createRec.response?.body, create.idLocation);
    }

    const id = entityResult.createdId;
    // Marker the entity currently should carry; updated by the update op.
    let currentMarker = marker;

    if (id !== null) {
      const readParams = itemParams(create.idLocation, wl.read, id);

      // 2. READ (read-your-writes)
      if (wl.read) {
        entityResult.ops.push(
          await runOne({ type: 'read', entity: wl.entity, marker: currentMarker, method: wl.read.method, template: wl.read.template, params: readParams, headers }),
        );
      }
      // 3. LIST (create-appears-in-subsequent-list)
      if (wl.list) {
        entityResult.ops.push(
          await runOne({ type: 'list', entity: wl.entity, marker: currentMarker, method: wl.list.method, template: wl.list.template, params: {}, headers }),
        );
      }
      // 4. UPDATE (a second marked write; monotonic reads afterward)
      if (wl.update) {
        const updateMarker = wl.update.markerField ? mint(markers, genId) : currentMarker;
        const updateBody = wl.update.markerField && updateMarker ? { [wl.update.markerField]: updateMarker } : {};
        const updateParams = itemParams(wl.update.idLocation, wl.update, id);
        const updateRec = await runOne({
          type: 'update',
          entity: wl.entity,
          marker: updateMarker,
          method: wl.update.method,
          template: wl.update.template,
          params: updateParams,
          headers,
          body: updateBody,
        });
        entityResult.ops.push(updateRec);
        if (updateRec.outcome === 'ok' && updateMarker) currentMarker = updateMarker;

        // 5. READ again (monotonic read: never observe an older marker)
        if (wl.read) {
          entityResult.ops.push(
            await runOne({ type: 'read', entity: wl.entity, marker: currentMarker, method: wl.read.method, template: wl.read.template, params: readParams, headers }),
          );
        }
      }
      // 6. DELETE. Guarded: only issued when the delete template actually
      // addresses the created id (see deleteAddressesId) — a collection-level
      // DELETE template would hit far more than the one probe entity. A
      // skipped delete leaves the entity for cleanup, which reports it as
      // skipped-unsafe.
      if (wl.delete && deleteAddressesId(wl.delete, itemParams(wl.delete.idLocation, wl.delete, id))) {
        const deleteParams = itemParams(wl.delete.idLocation, wl.delete, id);
        const deleteRec = await runOne({
          type: 'delete',
          entity: wl.entity,
          marker: currentMarker,
          method: wl.delete.method,
          template: wl.delete.template,
          params: deleteParams,
          headers,
        });
        entityResult.ops.push(deleteRec);
        if (deleteRec.outcome === 'ok') entityResult.deleted = true;

        // 7. READ after delete (no-resurrection-after-delete)
        if (wl.read) {
          entityResult.ops.push(
            await runOne({ type: 'read', entity: wl.entity, marker: currentMarker, method: wl.read.method, template: wl.read.template, params: readParams, headers }),
          );
        }
      }
    }

    entities.push(entityResult);
  }

  const cleanup = await cleanupEntities(entities, bounded, baseUrl, headers, http, now, timeoutMs, nextOpId, allOps);

  return { ops: allOps, entities, markers: [...markers], cleanup };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Mint a marker, record it in the run's marker set, and return it. */
function mint(markers: Set<string>, genId?: () => string): string {
  const m = genId ? newMarker(genId) : newMarker();
  markers.add(m);
  return m;
}

/** Names of the `:param` segments in a template. */
function templateParamNames(template: string): string[] {
  const segments = template === '/' ? [] : template.replace(/^\//, '').split('/');
  return segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
}

/**
 * True when invoking `del` with `params` (all of whose values are the entity
 * id) actually addresses that id: the template must bind at least one of the
 * params. renderTemplate silently ignores EXTRA params, so a collection-level
 * template like `DELETE /users` would otherwise render fine and hit a much
 * broader endpoint than the one entity we mean to delete.
 */
function deleteAddressesId(del: EndpointEntry, params: Record<string, string>): boolean {
  const names = templateParamNames(del.template);
  return names.some((name) => params[name] !== undefined);
}

/** Build the path-param map for an item endpoint, mapping its id path param to
 * the created id. Falls back to the create idLocation's param when the item
 * endpoint's own idLocation is not a path param. */
function itemParams(createIdLocation: IdLocation, itemEndpoint: EndpointEntry | undefined, id: string): Record<string, string> {
  const params: Record<string, string> = {};
  const loc = itemEndpoint?.idLocation;
  if (loc && loc.kind === 'path') {
    params[loc.param] = id;
  }
  if (createIdLocation.kind === 'path') {
    params[createIdLocation.param] = id;
  }
  // Last resort: many item templates use `:id`.
  if (Object.keys(params).length === 0) params.id = id;
  return params;
}

/** Everything needed to issue one op, before the URL is rendered. */
interface OpSpec {
  type: ProbeOpType;
  entity: string;
  marker: string | null;
  method: string;
  template: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

interface ExecuteOpArgs {
  opId: string;
  spec: OpSpec;
  baseUrl: string;
  http: ProbeHttpClient;
  now: () => number;
  timeoutMs: number;
}

/**
 * Render the op's URL, issue one request, and turn it into a ProbeOpRecord.
 * This is the single point where outcome classification lives:
 *  - a definite response -> `ok` (2xx) or `fail` (non-2xx);
 *  - a timeout error -> `indeterminate`;
 *  - any other pre-flight network error -> `fail`;
 *  - a TemplateRenderError (URL could not be built) -> `fail`, no request
 *    ever issued.
 */
async function executeOp(args: ExecuteOpArgs): Promise<ProbeOpRecord> {
  const { opId, spec, baseUrl, http, now, timeoutMs } = args;
  const { type, entity, marker } = spec;
  const invokeTs = now();

  let url: string;
  try {
    url = joinUrl(baseUrl, renderTemplate(spec.template, spec.params));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const request: ProbeRequestRecord = {
      method: spec.method,
      url: `${baseUrl}${spec.template}`,
      ...(spec.body !== undefined ? { body: spec.body } : {}),
    };
    return { opId, type, entity, marker, invokeTs, completeTs: now(), outcome: 'fail', request, error: message };
  }

  const request: ProbeRequestRecord = {
    method: spec.method,
    url,
    ...(spec.body !== undefined ? { body: spec.body } : {}),
  };
  const req: ProbeHttpRequest = {
    method: spec.method,
    url,
    headers: spec.headers,
    ...(spec.body !== undefined ? { body: spec.body } : {}),
  };

  let res: ProbeHttpResponse;
  try {
    res = await http(req, { timeoutMs });
  } catch (err) {
    const completeTs = now();
    if (err instanceof ProbeHttpError && err.kind === 'timeout') {
      return { opId, type, entity, marker, invokeTs, completeTs, outcome: 'indeterminate', request, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { opId, type, entity, marker, invokeTs, completeTs, outcome: 'fail', request, error: message };
  }

  const completeTs = now();
  const outcome: ProbeOutcome = res.status >= 200 && res.status < 300 ? 'ok' : 'fail';
  return {
    opId,
    type,
    entity,
    marker,
    invokeTs,
    completeTs,
    outcome,
    request,
    response: { status: res.status, ...(res.body !== undefined ? { body: res.body } : {}) },
    ...(outcome === 'fail' ? { error: `HTTP ${res.status}` } : {}),
  };
}

/**
 * Best-effort cleanup: delete every created entity the CRUD sequence did not
 * already delete. Records each attempt and appends the delete op to the run's
 * op log so the checker still sees it. A timeout leaves the entity possibly-
 * present; it is reported as not-deleted (indeterminate) so a human can follow
 * up.
 */
async function cleanupEntities(
  entities: EntityWorkloadResult[],
  workloads: EntityWorkload[],
  baseUrl: string,
  headers: Record<string, string>,
  http: ProbeHttpClient,
  now: () => number,
  timeoutMs: number,
  nextOpId: () => string,
  allOps: ProbeOpRecord[],
): Promise<CleanupResult> {
  const wlByEntity = new Map(workloads.map((w) => [w.entity, w]));
  const attempts: CleanupAttempt[] = [];
  let deleted = 0;

  for (const ent of entities) {
    if (ent.createdId === null || ent.deleted) continue;
    const wl = wlByEntity.get(ent.entity);
    const del = wl?.delete;
    if (!del) {
      // Nothing we can do — no delete endpoint. Report as a failed attempt so
      // the leftover is visible.
      attempts.push({ entity: ent.entity, id: ent.createdId, outcome: 'fail', error: 'no approved delete endpoint' });
      continue;
    }
    const params = itemParams(wl!.create!.idLocation, del, ent.createdId);
    if (!deleteAddressesId(del, params)) {
      // The delete template does not bind the entity id — issuing it could
      // hit a collection-level (or otherwise broader) endpoint. Never fire it.
      attempts.push({
        entity: ent.entity,
        id: ent.createdId,
        outcome: 'skipped-unsafe',
        error: `delete template "${del.template}" does not address the entity id; refusing to invoke a broader delete`,
      });
      continue;
    }
    const rec = await executeOp({
      opId: nextOpId(),
      spec: { type: 'delete', entity: ent.entity, marker: ent.marker, method: del.method, template: del.template, params, headers },
      baseUrl,
      http,
      now,
      timeoutMs,
    });
    allOps.push(rec);
    if (rec.outcome === 'ok') {
      ent.deleted = true;
      deleted++;
    }
    attempts.push({
      entity: ent.entity,
      id: ent.createdId,
      outcome: rec.outcome,
      ...(rec.error ? { error: rec.error } : {}),
    });
  }

  return { attempted: attempts.length, deleted, attempts };
}
