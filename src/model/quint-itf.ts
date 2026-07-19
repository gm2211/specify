/**
 * src/model/quint-itf.ts — Parser for the Informal Trace Format (ITF) JSON that
 * `quint run` emits (SP-i35, opt-in Quint spec integration).
 *
 * ITF is Informal Systems' language-neutral trace interchange format: a run of
 * a state machine as an ordered list of STATES, each a record of variable
 * assignments. Quint's `quint run --out-itf <file>` writes one ITF document per
 * simulated trace. This module decodes that document into plain JS values and
 * hands back an ordered state list the bridge (src/model/quint-bridge.ts) turns
 * into an executable browser trace.
 *
 * WHY A DECODER AT ALL
 * ----------------------------------------------------------------------------
 * ITF does not encode every value as raw JSON — JSON has no bigint, set, map, or
 * tuple, and Apalache/Quint need all four. The format therefore wraps them in
 * tagged single-key objects:
 *
 *   - `{ "#bigint": "42" }`        → a big integer (decoded to a JS number when
 *                                     it is safe-integer-sized, else kept as the
 *                                     decimal string so no precision is lost).
 *   - `{ "#set": [ ... ] }`        → a set (decoded to a JS array, elements
 *                                     recursively decoded).
 *   - `{ "#tup": [ ... ] }`        → a tuple (decoded to a JS array).
 *   - `{ "#map": [[k, v], ... ] }` → a map (decoded to an array of
 *                                     `[decodedKey, decodedValue]` pairs — a
 *                                     plain object is NOT used because ITF map
 *                                     keys can be non-string).
 *   - `{ "#unserializable": "…" }` → a value Quint could not serialize; decoded
 *                                     to the sentinel `{ unserializable: "…" }`
 *                                     so a consumer can detect and skip it
 *                                     rather than crash.
 *
 * Records, booleans, strings and null pass through as-is (records recursively).
 * A `#meta` key on the document or on a state is metadata, never a variable, and
 * is stripped from decoded states.
 *
 * TOLERANT BY DESIGN
 * ----------------------------------------------------------------------------
 * A malformed document does not throw: `parseItfTrace` returns a structured
 * result with an `errors` list so the caller (the bridge, or a CLI) can report
 * drift rather than crash mid-run — mirroring the trace monitor's three-outcome
 * discipline, where "could not read the data" is its own category, distinct from
 * a genuine negative. The one hard failure is a top-level value that is not an
 * object at all; that is reported as a single error with an empty state list.
 */

// ---------------------------------------------------------------------------
// Decoded value shapes
// ---------------------------------------------------------------------------

/** A value Quint could not serialize; surfaced rather than dropped. */
export interface ItfUnserializable {
  unserializable: string;
}

/** A decoded ITF map: an ordered list of `[key, value]` pairs (keys may be non-string). */
export interface ItfMap {
  map: Array<[ItfValue, ItfValue]>;
}

/** Any decoded ITF value. */
export type ItfValue =
  | string
  | number
  | boolean
  | null
  | ItfUnserializable
  | ItfMap
  | ItfValue[]
  | { [key: string]: ItfValue };

/** One decoded state: variable name → decoded value (the `#meta` key removed). */
export type ItfState = Record<string, ItfValue>;

/** A fully-parsed ITF document. */
export interface ItfTrace {
  /** Declared variable names, in document order (empty when `vars` was absent). */
  vars: string[];
  /** Ordered states of the trace. */
  states: ItfState[];
  /** Document-level `#meta`, passed through untouched (source, format, varTypes, …). */
  meta: Record<string, unknown>;
}

export interface ParseItfResult {
  trace: ItfTrace;
  /** Non-fatal decode problems (malformed state, unexpected shape). Empty ⇒ clean. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Recursion depth cap for `decodeItfValue`. ITF documents come from an
 * EXTERNAL tool's output; a pathologically (or maliciously) nested document
 * must not be able to blow the JS call stack — per the parser's
 * report-not-throw contract, hitting the cap is a structured parse error
 * (the subtree decodes to `null` and `onError` is notified), never a crash.
 * 128 is far beyond any state shape a real Quint model produces.
 */
export const MAX_ITF_DEPTH = 128;

function isTagged(value: object, tag: string): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === tag;
}

/**
 * Decode one raw ITF value into an `ItfValue`. Never throws — an unexpected
 * shape is decoded best-effort (e.g. a malformed `#bigint` falls back to its
 * string). `onError` collects a note for anything genuinely lossy. Nesting
 * beyond {@link MAX_ITF_DEPTH} is reported and decoded as `null` (see the
 * constant's doc for why the cap exists).
 */
export function decodeItfValue(raw: unknown, onError: (msg: string) => void, depth = 0): ItfValue {
  if (depth > MAX_ITF_DEPTH) {
    onError(`value nesting exceeds the maximum depth of ${MAX_ITF_DEPTH} — subtree dropped`);
    return null;
  }
  if (raw === null) return null;
  const t = typeof raw;
  if (t === 'string' || t === 'boolean' || t === 'number') {
    return raw as string | boolean | number;
  }
  if (Array.isArray(raw)) {
    return raw.map((el) => decodeItfValue(el, onError, depth + 1));
  }
  if (t !== 'object') {
    onError(`unsupported ${t} value in trace`);
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (isTagged(obj, '#bigint')) {
    const s = String(obj['#bigint']);
    // Keep exact string when the magnitude would lose precision as a JS number.
    if (/^-?\d+$/.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n) && Math.abs(n) <= MAX_SAFE) return n;
      return s;
    }
    onError(`malformed #bigint "${s}"`);
    return s;
  }
  if (isTagged(obj, '#set')) {
    const items = obj['#set'];
    if (!Array.isArray(items)) {
      onError('#set value is not an array');
      return [];
    }
    return items.map((el) => decodeItfValue(el, onError, depth + 1));
  }
  if (isTagged(obj, '#tup')) {
    const items = obj['#tup'];
    if (!Array.isArray(items)) {
      onError('#tup value is not an array');
      return [];
    }
    return items.map((el) => decodeItfValue(el, onError, depth + 1));
  }
  if (isTagged(obj, '#map')) {
    const pairs = obj['#map'];
    if (!Array.isArray(pairs)) {
      onError('#map value is not an array of pairs');
      return { map: [] };
    }
    const decoded: Array<[ItfValue, ItfValue]> = [];
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        onError('#map entry is not a [key, value] pair');
        continue;
      }
      decoded.push([decodeItfValue(pair[0], onError, depth + 1), decodeItfValue(pair[1], onError, depth + 1)]);
    }
    return { map: decoded };
  }
  if (isTagged(obj, '#unserializable')) {
    return { unserializable: String(obj['#unserializable']) };
  }

  // A plain record: decode each field, dropping any nested `#meta`.
  const out: Record<string, ItfValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '#meta') continue;
    out[key] = decodeItfValue(value, onError, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw (already-`JSON.parse`d) ITF document into an `ItfTrace`. Tolerant:
 * decode problems are collected into `errors` rather than thrown, so a caller
 * can report drift and continue. The only case that yields an empty trace is a
 * non-object root.
 */
export function parseItfTrace(raw: unknown): ParseItfResult {
  const errors: string[] = [];
  const onError = (msg: string): void => {
    errors.push(msg);
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      trace: { vars: [], states: [], meta: {} },
      errors: ['ITF document root is not an object'],
    };
  }
  const doc = raw as Record<string, unknown>;

  const meta =
    doc['#meta'] && typeof doc['#meta'] === 'object' && !Array.isArray(doc['#meta'])
      ? (doc['#meta'] as Record<string, unknown>)
      : {};

  const vars = Array.isArray(doc.vars)
    ? doc.vars.filter((v): v is string => typeof v === 'string')
    : [];

  const rawStates = Array.isArray(doc.states) ? doc.states : [];
  if (!Array.isArray(doc.states)) {
    onError('ITF document has no "states" array');
  }

  const states: ItfState[] = [];
  rawStates.forEach((rawState, i) => {
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
      onError(`state ${i} is not an object`);
      return;
    }
    const decoded = decodeItfValue(rawState, (m) => onError(`state ${i}: ${m}`));
    // A record decodes to a plain object; guard the (impossible) non-object case.
    states.push(
      decoded && typeof decoded === 'object' && !Array.isArray(decoded) && !('map' in decoded) && !('unserializable' in decoded)
        ? (decoded as ItfState)
        : {},
    );
  });

  return { trace: { vars, states, meta }, errors };
}

/**
 * Parse a raw ITF document that may itself be a JSON string. Convenience over
 * `parseItfTrace` for the runner, which reads a file. A JSON parse error is
 * reported as a single `errors` entry (never thrown).
 */
export function parseItfJson(text: string): ParseItfResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      trace: { vars: [], states: [], meta: {} },
      errors: [`ITF is not valid JSON: ${(err as Error).message}`],
    };
  }
  return parseItfTrace(raw);
}
