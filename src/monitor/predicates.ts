/**
 * src/monitor/predicates.ts — Predicate registry v1: the atomic propositions an
 * LTLf formula (src/monitor/formula.ts) can name, and their grounding in the
 * trace model (src/monitor/trace.ts).
 *
 * WHY THIS FILE MATTERS
 * ----------------------------------------------------------------------------
 * A formula is only as sound as its atomic propositions. This registry is the
 * single source of truth for what each predicate NAME means, what data it
 * needs, and what verdict it returns in every corner case. `generatePredicateDocs()`
 * renders that source of truth to markdown; a later bead (SP-o9z) feeds that
 * markdown verbatim into a compile prompt that turns plain-language spec
 * behaviors into formulas over these exact predicates. If the doc drifts from
 * the code, the compiler drifts from reality — so doc text lives right next to
 * the `evalFn` it describes, and the generator reads it directly from the
 * registry (no hand-copied second source).
 *
 * TWO PREDICATE SORTS (mirrors trace.ts's two-sorted semantics)
 * ----------------------------------------------------------------------------
 *   - `requires: 'events'` — EVENT predicates. Grounded in `state.events`, the
 *     window of TraceEvent entries attached to this position (see trace.ts's
 *     STATE vs EVENT discussion). This registry's event predicates read two
 *     event shapes: `HttpTraceEvent` (kind: 'http', wrapping a CapturedTraffic
 *     request/response pair) and `ConsoleTraceEvent` (kind: 'console', wrapping
 *     a CapturedConsoleEntry). See `httpTraceEvent`/`consoleTraceEvent` below
 *     for the builders a trace-construction step should use to populate
 *     `TraceState.events` from CaptureCollector output + StepObservation's
 *     trafficRange/consoleRange index slices.
 *   - `requires: 'step'` — STEP predicates. Grounded in `state.step`, expected
 *     to be a `StepObservation` (src/agent/observation.ts). Evaluating a step
 *     predicate needs more than the single TraceState, though: `ax.role`
 *     resolves `{unchanged: true, digest}` chains by walking BACKWARD through
 *     the trace to find the last position that actually wrote an AX file, so
 *     `evalFn` takes a `PredicateContext` carrying the full `Trace` and the
 *     directory AX file paths are relative to. `createRegistryEvaluator` below
 *     is the adapter that closes over that context and hands back a plain
 *     `PredicateEvaluator` — the shape trace.ts's evaluator actually calls.
 *
 * THREE-OUTCOME EVALUATION IS NOT OPTIONAL
 * ----------------------------------------------------------------------------
 * Every `evalFn` in this file returns `true | false | 'unevaluable'` and NEVER
 * throws. `'unevaluable'` is the drift-detection signal: a predicate that
 * MATTERS for a formula's verdict but couldn't be computed (missing capture
 * data, malformed regex arg, absent step, absent AX snapshot, ...) surfaces as
 * Kleene "unknown" rather than silently resolving to `false` (which would look
 * identical to a genuine negative result) or throwing (which would crash the
 * whole evaluation instead of just this one atom). See evaluate.ts's 4-valued
 * combinators for how 'unevaluable' propagates.
 *
 * URL PATTERN CONVENTION
 * ----------------------------------------------------------------------------
 * Every `urlPattern` / `regex` argument in this registry is a JavaScript
 * regular expression source string, matched with `RegExp.prototype.test`
 * (no anchors implied — a bare pattern matches a substring, exactly like an
 * unanchored regex normally would). This is applied UNIFORMLY across every
 * predicate that takes a pattern argument (http.*, console.*, page.*, ax.*).
 * Callers who want literal substring matching should regex-escape their
 * string first (see `escapeRegExp`, exported for that purpose) or rely on the
 * fact that most literal substrings (plain paths like `/api/session`) are
 * already valid regex source as-is. A malformed regex source string is a
 * predicate-evaluation failure, not a data-absence failure, but it is reported
 * the same way: `'unevaluable'`, never a thrown SyntaxError.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { CapturedConsoleEntry, CapturedTraffic } from '../capture/types.js';
import type { AxObservation, StepObservation } from '../agent/observation.js';
import type { PredicateEvaluator, PredicateRef, PredicateVerdict, Trace, TraceEvent, TraceState } from './trace.js';

// ==============================================================================
// Event shapes carried on TraceState.events
// ==============================================================================

/** A TraceEvent wrapping one captured HTTP request/response pair. */
export interface HttpTraceEvent extends TraceEvent {
  kind: 'http';
  traffic: CapturedTraffic;
}

/** A TraceEvent wrapping one captured console log entry. */
export interface ConsoleTraceEvent extends TraceEvent {
  kind: 'console';
  entry: CapturedConsoleEntry;
}

/** Build a trace event from a captured HTTP request/response pair. */
export function httpTraceEvent(traffic: CapturedTraffic): HttpTraceEvent {
  return { ts: traffic.tsEnd ?? traffic.ts, kind: 'http', traffic };
}

/** Build a trace event from a captured console log entry. */
export function consoleTraceEvent(entry: CapturedConsoleEntry): ConsoleTraceEvent {
  return { ts: entry.ts, kind: 'console', entry };
}

function httpEvents(state: TraceState): HttpTraceEvent[] {
  return state.events.filter((e): e is HttpTraceEvent => e.kind === 'http');
}

function consoleEvents(state: TraceState): ConsoleTraceEvent[] {
  return state.events.filter((e): e is ConsoleTraceEvent => e.kind === 'console');
}

// ==============================================================================
// Shared arg helpers
// ==============================================================================

/** Escape a literal string for safe embedding in a regex pattern. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a pattern arg to a RegExp; `null` on malformed source (=> 'unevaluable'). */
// `pattern` is a predicate arg (urlPattern/regex), dynamic by design; malformed
// or unsafe source is a predicate-author error and is contained by the
// try/catch + 'unevaluable' fallback below, never propagated as a crash.
function safeRegex(pattern: string): RegExp | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];

function statusInClass(status: number, cls: string): boolean | 'unevaluable' {
  if (!STATUS_CLASSES.includes(cls as StatusClass)) return 'unevaluable';
  const digit = Math.floor(status / 100);
  return `${digit}xx` === cls;
}

/** Get a dotted path (e.g. "user.id" or "items.0.name") out of a parsed JSON value. */
function getPath(value: unknown, dottedPath: string): { found: true; value: unknown } | { found: false } {
  const parts = dottedPath.split('.').filter((p) => p.length > 0);
  let cur = value;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return { found: false };
    if (!(part in (cur as Record<string, unknown>))) return { found: false };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
}

/** Loose equality for response_json's `value` arg, which always arrives as a string. */
function valueEquals(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string') return actual === expected;
  if (typeof actual === 'number' || typeof actual === 'boolean') return String(actual) === expected;
  if (actual === null) return expected === 'null';
  // Objects/arrays: compare against the expected string parsed as JSON, else stringified.
  try {
    return JSON.stringify(actual) === JSON.stringify(JSON.parse(expected));
  } catch {
    return JSON.stringify(actual) === expected;
  }
}

// ==============================================================================
// Registry types
// ==============================================================================

/** Context threaded through step predicates that need more than the single position. */
export interface PredicateContext {
  /** The full trace, for step predicates that must look backward (ax.role). */
  trace: Trace;
  /**
   * Directory that AxObservation.file paths are relative to (the capture
   * outputDir passed to ObservationRecorder). Required for ax.role; other
   * predicates ignore it.
   */
  axBaseDir?: string;
}

export interface PredicateDefinition {
  /** Which half of the two-sorted trace this predicate reads. */
  requires: 'events' | 'step';
  /** Precise semantics, including what each arg means and every edge case. Feeds generatePredicateDocs(). */
  doc: string;
  /** Example invocations (args arrays), rendered into the generated docs. */
  examples: string[][];
  /** Evaluate this predicate at one trace position. Never throws. */
  evalFn(state: TraceState, args: string[], ctx: PredicateContext): PredicateVerdict;
}

export type PredicateRegistry = Record<string, PredicateDefinition>;

// ==============================================================================
// EVENT PREDICATES
// ==============================================================================

const httpRequest: PredicateDefinition = {
  requires: 'events',
  doc:
    'True iff a captured HTTP request whose URL matches `urlPattern` (and, if given, whose ' +
    "method equals `method` case-insensitively) occurred in this position's event window. " +
    'Args: `[urlPattern]` (any method) or `[method, urlPattern]`. `urlPattern` is a regex source ' +
    "string tested against the request URL (see module doc for the regex convention). " +
    "'unevaluable' iff `urlPattern` fails to compile as a regex; never unevaluable merely because " +
    'no request occurred (that is a genuine `false`, distinct from http.no_request\'s success case).',
  examples: [['GET', '/api/session'], ['/api/session']],
  evalFn(state, args) {
    const [method, urlPattern] = args.length >= 2 ? [args[0], args[1]] : [undefined, args[0]];
    if (urlPattern === undefined) return 'unevaluable';
    const re = safeRegex(urlPattern);
    if (!re) return 'unevaluable';
    return httpEvents(state).some(
      (e) =>
        re.test(e.traffic.url) &&
        (method === undefined || e.traffic.method.toUpperCase() === method.toUpperCase()),
    );
  },
};

const httpResponse: PredicateDefinition = {
  requires: 'events',
  doc:
    'True iff a captured HTTP response whose request URL matches `urlPattern` has status ' +
    '(exactly) equal to `status`. Args: `[urlPattern, status]`. \'unevaluable\' iff `urlPattern` ' +
    'fails to compile, `status` is not a valid integer, or no matching-URL response exists in the ' +
    'window at all (we cannot say a specific status did NOT occur if we never observed the URL — ' +
    'contrast with http.no_request, which is the deliberate absence predicate). If a matching-URL ' +
    'response DID occur but with a different status, the verdict is `false` (a definite negative).',
  examples: [['/api/session', '200']],
  evalFn(state, args) {
    const [urlPattern, statusStr] = args;
    if (urlPattern === undefined || statusStr === undefined) return 'unevaluable';
    const re = safeRegex(urlPattern);
    const status = Number(statusStr);
    if (!re || !Number.isInteger(status)) return 'unevaluable';
    const matches = httpEvents(state).filter((e) => re.test(e.traffic.url));
    if (matches.length === 0) return 'unevaluable';
    return matches.some((e) => e.traffic.status === status);
  },
};

const httpStatusClass: PredicateDefinition = {
  requires: 'events',
  doc:
    "True iff a captured response for a matching URL has a status in the given class. Args: " +
    "`[urlPattern, class]`, class in `'2xx'|'3xx'|'4xx'|'5xx'`. Same absence handling as " +
    "http.response: no matching-URL response observed at all => 'unevaluable'; matching-URL " +
    "response observed but in a different class => `false`.",
  examples: [['/api/', '2xx'], ['/api/', '5xx']],
  evalFn(state, args) {
    const [urlPattern, cls] = args;
    if (urlPattern === undefined || cls === undefined) return 'unevaluable';
    const re = safeRegex(urlPattern);
    if (!re) return 'unevaluable';
    const matches = httpEvents(state).filter((e) => re.test(e.traffic.url));
    if (matches.length === 0) return 'unevaluable';
    let sawUnevaluable = false;
    for (const e of matches) {
      const r = statusInClass(e.traffic.status, cls);
      if (r === 'unevaluable') {
        sawUnevaluable = true;
        continue;
      }
      if (r) return true;
    }
    return sawUnevaluable ? 'unevaluable' : false;
  },
};

const httpResponseJson: PredicateDefinition = {
  requires: 'events',
  doc:
    'True iff a captured response for a matching URL has a body that parses as JSON and the ' +
    'dotted `path` (e.g. `user.id`, `items.0.name`) resolves to a value equal to `value` ' +
    '(numbers/booleans/null compared by string form; objects/arrays by JSON deep-equality). ' +
    'Args: `[urlPattern, path, value]`. ASYMMETRY (documented deliberately): if the response body ' +
    'is absent or fails to parse as JSON, the verdict is \'unevaluable\' — we cannot rule on a ' +
    'path we could not read. If the body DID parse but `path` does not resolve to anything in it, ' +
    'the verdict is `false` — a present, well-formed document that lacks the field is a genuine ' +
    'negative, not a data-collection failure. No matching-URL response observed at all => ' +
    "'unevaluable' (mirrors http.response).",
  examples: [['/api/session', 'user.id', '42'], ['/api/cart', 'items.0.sku', 'ABC123']],
  evalFn(state, args) {
    const [urlPattern, path, expected] = args;
    if (urlPattern === undefined || path === undefined || expected === undefined) return 'unevaluable';
    const re = safeRegex(urlPattern);
    if (!re) return 'unevaluable';
    const matches = httpEvents(state).filter((e) => re.test(e.traffic.url));
    if (matches.length === 0) return 'unevaluable';

    let sawParseable = false;
    for (const e of matches) {
      const body = e.traffic.responseBody;
      if (body === null || body === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      sawParseable = true;
      const got = getPath(parsed, path);
      if (got.found && valueEquals(got.value, expected)) return true;
    }
    return sawParseable ? false : 'unevaluable';
  },
};

const httpBodyMatches: PredicateDefinition = {
  requires: 'events',
  doc:
    'True iff a captured response for a matching URL has a body (string) that matches `regex`. ' +
    'Args: `[urlPattern, regex]`. \'unevaluable\' iff urlPattern/regex fail to compile, no ' +
    "matching-URL response was observed, or every matching-URL response has a null/absent body. " +
    'If at least one matching-URL response has a captured (non-null) body, the verdict is a ' +
    'definite true/false over those bodies.',
  examples: [['/api/session', '"status"\\s*:\\s*"ok"']],
  evalFn(state, args) {
    const [urlPattern, pattern] = args;
    if (urlPattern === undefined || pattern === undefined) return 'unevaluable';
    const urlRe = safeRegex(urlPattern);
    const bodyRe = safeRegex(pattern);
    if (!urlRe || !bodyRe) return 'unevaluable';
    const matches = httpEvents(state).filter((e) => urlRe.test(e.traffic.url));
    if (matches.length === 0) return 'unevaluable';
    const withBody = matches.filter((e) => e.traffic.responseBody !== null && e.traffic.responseBody !== undefined);
    if (withBody.length === 0) return 'unevaluable';
    return withBody.some((e) => bodyRe.test(e.traffic.responseBody as string));
  },
};

const httpPostDataMatches: PredicateDefinition = {
  requires: 'events',
  doc:
    'True iff a captured request for a matching URL has POST body data matching `regex`. Args: ' +
    "`[urlPattern, regex]`. 'unevaluable' iff urlPattern/regex fail to compile, no matching-URL " +
    "request was observed, or every matching-URL request has null postData. Otherwise a definite " +
    'true/false over the requests that do have postData.',
  examples: [['/api/checkout', '"cardType"']],
  evalFn(state, args) {
    const [urlPattern, pattern] = args;
    if (urlPattern === undefined || pattern === undefined) return 'unevaluable';
    const urlRe = safeRegex(urlPattern);
    const dataRe = safeRegex(pattern);
    if (!urlRe || !dataRe) return 'unevaluable';
    const matches = httpEvents(state).filter((e) => urlRe.test(e.traffic.url));
    if (matches.length === 0) return 'unevaluable';
    const withData = matches.filter((e) => e.traffic.postData !== null && e.traffic.postData !== undefined);
    if (withData.length === 0) return 'unevaluable';
    return withData.some((e) => dataRe.test(e.traffic.postData as string));
  },
};

const httpNoRequest: PredicateDefinition = {
  requires: 'events',
  doc:
    'ABSENCE predicate: true iff NO captured request in this window has a URL matching ' +
    "`urlPattern`. Args: `[urlPattern]`. Unlike the other http.* predicates, this one is defined " +
    "over the empty case by design (its entire purpose is to assert non-occurrence), so it never " +
    "returns 'unevaluable' for \"no matching request\" — only for a malformed `urlPattern`.",
  examples: [['/api/legacy-endpoint']],
  evalFn(state, args) {
    const [urlPattern] = args;
    if (urlPattern === undefined) return 'unevaluable';
    const re = safeRegex(urlPattern);
    if (!re) return 'unevaluable';
    return !httpEvents(state).some((e) => re.test(e.traffic.url));
  },
};

const consoleError: PredicateDefinition = {
  requires: 'events',
  doc:
    "True iff a console entry of type 'error' occurred in this window, optionally further " +
    'filtered by `regex` matching the entry text. Args: `[]` (any error) or `[regex]`. ' +
    "'unevaluable' iff `regex` is supplied and fails to compile; never unevaluable merely because " +
    'no error occurred (that is a genuine `false`).',
  examples: [[], ['Uncaught TypeError']],
  evalFn(state, args) {
    const [pattern] = args;
    let re: RegExp | null = null;
    if (pattern !== undefined) {
      re = safeRegex(pattern);
      if (!re) return 'unevaluable';
    }
    return consoleEvents(state).some((e) => e.entry.type === 'error' && (!re || re.test(e.entry.text)));
  },
};

const consoleMessage: PredicateDefinition = {
  requires: 'events',
  doc:
    'True iff a console entry of the given `type` (exact match, e.g. `log`, `warn`, `error`, ' +
    '`info`, `debug`) occurred whose text matches `regex`. Args: `[type, regex]`. \'unevaluable\' ' +
    "iff `regex` fails to compile; never unevaluable merely because no matching entry occurred.",
  examples: [['warn', 'deprecated']],
  evalFn(state, args) {
    const [type, pattern] = args;
    if (type === undefined || pattern === undefined) return 'unevaluable';
    const re = safeRegex(pattern);
    if (!re) return 'unevaluable';
    return consoleEvents(state).some((e) => e.entry.type === type && re.test(e.entry.text));
  },
};

// ==============================================================================
// STEP PREDICATES
// ==============================================================================

function asStepObservation(state: TraceState): StepObservation | undefined {
  if (!state.step || typeof state.step !== 'object') return undefined;
  const s = state.step as Partial<StepObservation>;
  if (typeof s.action !== 'string' || typeof s.urlAfter !== 'string') return undefined;
  return state.step as StepObservation;
}

const stepAction: PredicateDefinition = {
  requires: 'step',
  doc:
    "True iff this position's step observation has `action` equal to `type` and, if given, its " +
    'recorded `args.selector` matches `selectorPattern`. Args: `[type]` or `[type, selectorPattern]`. ' +
    "'unevaluable' iff the position has no step observation, or `selectorPattern` is given but the " +
    'step has no recorded selector arg (we cannot rule on a selector we never captured) or the ' +
    "pattern fails to compile. If the step exists and action does not match, verdict is `false`.",
  examples: [['click'], ['fill', '#email']],
  evalFn(state, args) {
    const step = asStepObservation(state);
    if (!step) return 'unevaluable';
    const [type, selectorPattern] = args;
    if (type === undefined) return 'unevaluable';
    if (step.action !== type) return false;
    if (selectorPattern === undefined) return true;
    const selector = step.args?.selector;
    if (typeof selector !== 'string') return 'unevaluable';
    const re = safeRegex(selectorPattern);
    if (!re) return 'unevaluable';
    return re.test(selector);
  },
};

const pageUrl: PredicateDefinition = {
  requires: 'step',
  doc:
    "True iff this position's step observation's `urlAfter` matches `regex`. Args: `[regex]`. " +
    "'unevaluable' iff the position has no step observation or `regex` fails to compile.",
  examples: [['/checkout/confirmation$']],
  evalFn(state, args) {
    const step = asStepObservation(state);
    if (!step) return 'unevaluable';
    const [pattern] = args;
    if (pattern === undefined) return 'unevaluable';
    const re = safeRegex(pattern);
    if (!re) return 'unevaluable';
    return re.test(step.urlAfter);
  },
};

const pageTitle: PredicateDefinition = {
  requires: 'step',
  doc:
    "True iff this position's step observation's `title` matches `regex`. Args: `[regex]`. " +
    "'unevaluable' iff the position has no step observation, `title` was not captured for this " +
    "step (best-effort field — see observation.ts), or `regex` fails to compile.",
  examples: [['^Order Confirmed']],
  evalFn(state, args) {
    const step = asStepObservation(state);
    if (!step) return 'unevaluable';
    const [pattern] = args;
    if (pattern === undefined) return 'unevaluable';
    if (step.title === undefined) return 'unevaluable';
    const re = safeRegex(pattern);
    if (!re) return 'unevaluable';
    return re.test(step.title);
  },
};

// --- ax.role: tolerant line-based matcher over ariaSnapshot YAML --------------
//
// ariaSnapshot() (Playwright) renders an accessibility tree as YAML where each
// node is a list-item string of the form `role "accessible name"` (name
// optional), nested via YAML list indentation to mirror DOM nesting, e.g.:
//
//   - generic:
//     - heading "Checkout" [level=1]
//     - button "Place order"
//     - list:
//       - listitem: "Item 1"
//
// We parse the YAML into a plain JS tree (arrays/objects of strings) with
// js-yaml, then walk EVERY string value found anywhere in that tree (both list
// scalars like `button "Place order"` and mapping keys like `generic:`) with a
// single line-regex, rather than trying to model Playwright's node-shape
// grammar precisely. Rationale: ariaSnapshot's exact YAML shape (when a node
// is a scalar list item vs. a mapping key with nested children) depends on
// whether it has children and isn't documented as a stable grammar; a strict
// structural parser would be one Playwright version bump away from silently
// missing nodes. A line-regex over every string in the parsed tree is robust
// to that shape variance at the cost of not distinguishing nesting depth,
// which ax.role does not need (it only asserts "a node with this role and
// name exists somewhere in the snapshot").
// Flagged by the safe-regex heuristic; the group is non-nested and each
// alternative is bounded (no ambiguous repetition), so it is not exponential
// in practice. Applied to bounded YAML line strings only, never to
// unbounded/attacker-controlled input.
// eslint-disable-next-line security/detect-unsafe-regex
const AX_LINE_RE = /^([a-z][a-z0-9-]*)\b(?:\s+"([^"]*)")?/i;

function walkYamlStrings(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkYamlStrings(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out.push(key);
      walkYamlStrings(value, out);
    }
  }
}

/** Parse an ariaSnapshot YAML string into `{role, name}` entries. Tolerant: unparseable lines are skipped, not fatal. */
export function parseAriaSnapshot(snapshotYaml: string): Array<{ role: string; name?: string }> {
  let doc: unknown;
  try {
    doc = yaml.load(snapshotYaml);
  } catch {
    doc = null;
  }
  const strings: string[] = [];
  if (doc !== null && doc !== undefined) {
    walkYamlStrings(doc, strings);
  } else {
    // Fall back to raw-line scanning if the YAML itself didn't parse (e.g. an
    // unexpected top-level shape) — still try to extract role/name pairs.
    strings.push(...snapshotYaml.split('\n').map((l) => l.replace(/^[\s-]+/, '')));
  }

  const entries: Array<{ role: string; name?: string }> = [];
  for (const s of strings) {
    const m = AX_LINE_RE.exec(s.trim());
    if (m) entries.push({ role: m[1].toLowerCase(), name: m[2] });
  }
  return entries;
}

/** Resolve an AxObservation to snapshot YAML text, walking `{unchanged}` chains backward through the trace. Returns undefined if unresolvable. */
function resolveAxSnapshot(trace: Trace, position: number, axBaseDir: string | undefined): string | undefined {
  if (!axBaseDir) return undefined;

  for (let i = position; i >= 0; i--) {
    const step = asStepObservation(trace[i]);
    if (!step) continue;
    const ax: AxObservation = step.ax;
    if ('error' in ax) return undefined;
    if ('file' in ax) {
      try {
        return fs.readFileSync(path.join(axBaseDir, ax.file), 'utf-8');
      } catch {
        return undefined;
      }
    }
    // { unchanged: true, digest } — keep walking backward for the write.
  }
  return undefined;
}

const axRole: PredicateDefinition = {
  requires: 'step',
  doc:
    "True iff this position's resolved AX snapshot (ariaSnapshot YAML, resolving `{unchanged}` " +
    "chains backward through the trace to the last position that actually wrote a snapshot file — " +
    'see observation.ts\'s AxObservation) contains at least one node whose role equals `role` ' +
    '(case-insensitive) and, if given, whose accessible name matches `namePattern`. Args: `[role]` ' +
    "or `[role, namePattern]`. 'unevaluable' iff the position has no step observation, the step's " +
    "AxObservation is `{error}`, the snapshot file cannot be resolved/read (requires the " +
    "PredicateContext's `axBaseDir` — the capture outputDir), or `namePattern` is given but fails " +
    'to compile. If the snapshot resolves and parses but no node matches, verdict is `false`.',
  examples: [['button'], ['heading', 'Checkout']],
  evalFn(state, args, ctx) {
    const step = asStepObservation(state);
    if (!step) return 'unevaluable';
    const [role, namePattern] = args;
    if (role === undefined) return 'unevaluable';
    let nameRe: RegExp | null = null;
    if (namePattern !== undefined) {
      nameRe = safeRegex(namePattern);
      if (!nameRe) return 'unevaluable';
    }
    const snapshot = resolveAxSnapshot(ctx.trace, state.index, ctx.axBaseDir);
    if (snapshot === undefined) return 'unevaluable';
    const entries = parseAriaSnapshot(snapshot);
    const wantRole = role.toLowerCase();
    return entries.some(
      (e) => e.role === wantRole && (!nameRe || (e.name !== undefined && nameRe.test(e.name))),
    );
  },
};

// --- dom.*: live-sampled probes, evaluated over StepObservation.probes -------
//
// Unlike every predicate above (grounded in data captured mechanically by the
// runner and readable POST-HOC from the trace), dom.* predicates name a live
// DOM query (`document.querySelector`-style) that can only be answered while
// the page is actually open. Because APPROVED (and draft, for shadow-mode
// burn-in) formulas exist BEFORE a verify run starts, their dom.* predicate
// nodes are extracted into a ProbePlan (src/agent/probe-plan.ts) at session
// start and SAMPLED LIVE at each step (src/cli/commands/capture-agent.ts's
// executeCommand), recording a plain boolean into
// `StepObservation.probes[canonicalProbeKey(name, args)]`. The monitor stays
// a pure function over recorded data: these evalFns do nothing but look that
// recorded boolean up. A key that was never sampled (formula compiled after
// the run, probe errored/timed out, or the run predates this feature) is
// indistinguishable from one that was sampled false at the recording layer —
// so ABSENCE of the key (not `false`) is what maps to 'unevaluable' here.
//
// `canonicalProbeKey` is the single source of truth for turning a predicate
// name + positional args into the same string on both sides (extraction at
// probe-plan.ts and lookup here) — see its doc for the exact format.

const DOM_PREDICATE_ARG_NAMES: Record<string, string[]> = {
  'dom.exists': ['selector'],
  'dom.visible': ['selector'],
  'dom.text': ['selector', 'regex'],
  'dom.count': ['selector', 'op', 'n'],
};

/**
 * Canonical probe key for a dom.* predicate invocation: `name({"argName":"value",...})`,
 * with keys assigned from the predicate's documented positional argument
 * order (see `DOM_PREDICATE_ARG_NAMES`) and the object JSON.stringify'd for a
 * stable, dedupe-able, human-legible string, e.g. `dom.visible({"selector":"#toast"})`.
 * Used identically on both ends of the live-sampling pipeline: probe-plan.ts
 * extracts this key per predicate node to dedupe a ProbePlan, and
 * capture-agent.ts's sampler records the live-evaluated boolean under this
 * exact key on `StepObservation.probes`; the dom.* evalFns below look it up
 * the same way. A predicate name outside `DOM_PREDICATE_ARG_NAMES` falls back
 * to keying on the raw args array — still stable and dedupe-able, just not in
 * the documented `{"argName":...}` shape (not expected in practice, since
 * only the four dom.* names below are ever passed through this function).
 */
export function canonicalProbeKey(name: string, args: string[]): string {
  const argNames = DOM_PREDICATE_ARG_NAMES[name];
  if (!argNames) {
    return `${name}(${JSON.stringify(args)})`;
  }
  const obj: Record<string, string> = {};
  argNames.forEach((argName, i) => {
    if (args[i] !== undefined) obj[argName] = args[i];
  });
  return `${name}(${JSON.stringify(obj)})`;
}

const DOM_COUNT_OPS = new Set(['eq', 'gte', 'lte', 'gt', 'lt']);

/**
 * Shared evalFn factory for the four dom.* predicates: validate arg shape,
 * compute the canonical key, and look it up on the step's recorded probes.
 * `requiredArgCount` and `validate` gate malformed-arg 'unevaluable' the same
 * way the other predicates in this file do (see e.g. httpResponse's
 * Number.isInteger check) — this is purely arg-shape validation and never
 * touches the live page; the actual DOM query already ran (or didn't) at
 * capture time.
 */
function domProbeDefinition(
  name: string,
  requiredArgCount: number,
  doc: string,
  examples: string[][],
  validate?: (args: string[]) => boolean,
): PredicateDefinition {
  return {
    requires: 'step',
    doc,
    examples,
    evalFn(state, args) {
      const step = asStepObservation(state);
      if (!step) return 'unevaluable';
      if (args.length < requiredArgCount) return 'unevaluable';
      if (validate && !validate(args)) return 'unevaluable';
      const key = canonicalProbeKey(name, args);
      const probes = step.probes;
      if (!probes || !(key in probes)) return 'unevaluable';
      return probes[key];
    },
  };
}

const domExists = domProbeDefinition(
  'dom.exists',
  1,
  'LIVE PROBE. True iff a live DOM probe recorded at this step found at least one element ' +
    "matching the CSS `selector` (Playwright locator count > 0). Args: `[selector]`. 'unevaluable' " +
    "iff the position has no step observation, or no probe for this exact (selector) was sampled at " +
    'this step (formula compiled after the run, sampling timed out/errored, or the run predates live ' +
    'probe sampling — see module notes above). Never unevaluable merely because the element was ' +
    'genuinely absent (that is a recorded `false`).',
  [['#toast'], ['.cart-item']],
);

const domVisible = domProbeDefinition(
  'dom.visible',
  1,
  'LIVE PROBE. True iff a live DOM probe recorded at this step found the first element matching ' +
    "the CSS `selector` to be visible (Playwright locator `isVisible()`). Args: `[selector]`. " +
    "'unevaluable' iff the position has no step observation or no probe for this exact (selector) " +
    'was sampled at this step. A selector that matched no element, or matched one that is hidden, ' +
    'is a recorded `false`, not unevaluable.',
  [['#toast'], ['[role="alert"]']],
);

const domText = domProbeDefinition(
  'dom.text',
  2,
  'LIVE PROBE. True iff a live DOM probe recorded at this step found the first element matching ' +
    "the CSS `selector` to have text content matching `regex`. Args: `[selector, regex]`. " +
    "'unevaluable' iff `regex` fails to compile as a regex (checked here, independent of sampling), " +
    "the position has no step observation, or no probe for this exact (selector, regex) was sampled " +
    'at this step. An element that matched but whose text does not satisfy `regex` (or that has no ' +
    'text content) is a recorded `false`.',
  [['#status', 'Order placed']],
  (args) => safeRegex(args[1]) !== null,
);

const domCount = domProbeDefinition(
  'dom.count',
  3,
  'LIVE PROBE. True iff a live DOM probe recorded at this step found the number of elements ' +
    "matching the CSS `selector` to satisfy `count <op> n`, `op` one of `eq|gte|lte|gt|lt`. Args: " +
    "`[selector, op, n]`. 'unevaluable' iff `op` is not one of the five comparators or `n` does not " +
    "parse as a finite number (checked here, independent of sampling), the position has no step " +
    'observation, or no probe for this exact (selector, op, n) was sampled at this step. A count ' +
    'that fails the comparison is a recorded `false`.',
  [['.cart-item', 'gte', '1'], ['.error-banner', 'eq', '0']],
  (args) => DOM_COUNT_OPS.has(args[1]) && Number.isFinite(Number(args[2])),
);

// ==============================================================================
// Registry
// ==============================================================================

export const predicateRegistry: PredicateRegistry = {
  'http.request': httpRequest,
  'http.response': httpResponse,
  'http.status_class': httpStatusClass,
  'http.response_json': httpResponseJson,
  'http.body_matches': httpBodyMatches,
  'http.post_data_matches': httpPostDataMatches,
  'http.no_request': httpNoRequest,
  'console.error': consoleError,
  'console.message': consoleMessage,
  'step.action': stepAction,
  'page.url': pageUrl,
  'page.title': pageTitle,
  'ax.role': axRole,
  'dom.exists': domExists,
  'dom.visible': domVisible,
  'dom.text': domText,
  'dom.count': domCount,
};

// ==============================================================================
// PredicateEvaluator adapter
// ==============================================================================

/**
 * Build a `PredicateEvaluator` (the interface trace.ts's `evaluate()` calls)
 * backed by `predicateRegistry`. `trace` is threaded through as
 * `PredicateContext.trace` so step predicates (ax.role) can look backward.
 * Unknown predicate names evaluate to `'unevaluable'` rather than throwing.
 */
export function createRegistryEvaluator(
  trace: Trace,
  options: { registry?: PredicateRegistry; axBaseDir?: string } = {},
): PredicateEvaluator {
  const registry = options.registry ?? predicateRegistry;
  const ctx: PredicateContext = { trace, axBaseDir: options.axBaseDir };
  return {
    eval(pred: PredicateRef, state: TraceState): PredicateVerdict {
      const def = registry[pred.name];
      if (!def) return 'unevaluable';
      try {
        return def.evalFn(state, pred.args, ctx);
      } catch {
        // Defensive: a predicate implementation must never crash evaluation.
        return 'unevaluable';
      }
    },
  };
}

// ==============================================================================
// Docs generator
// ==============================================================================

/**
 * Render `predicateRegistry` to a markdown reference document: one section per
 * predicate with its data dependency, semantics doc, and example invocations.
 * Output is deterministic (registry insertion order, no timestamps) so it can
 * be snapshot-tested and diffed in review. Consumed verbatim by a future
 * compile prompt (SP-o9z) — do not add non-deterministic content here.
 */
export function generatePredicateDocs(registry: PredicateRegistry = predicateRegistry): string {
  const lines: string[] = [];
  lines.push('# Predicate Reference');
  lines.push('');
  lines.push(
    'Generated from src/monitor/predicates.ts (`generatePredicateDocs`). Every predicate below ' +
      "returns `true | false | 'unevaluable'` and never throws; `'unevaluable'` means its data " +
      'dependency was absent or malformed, not that the property is false.',
  );
  lines.push('');

  for (const [name, def] of Object.entries(registry)) {
    lines.push(`## \`${name}\``);
    lines.push('');
    lines.push(`- **requires**: \`${def.requires}\``);
    lines.push(`- **semantics**: ${def.doc}`);
    if (def.examples.length > 0) {
      lines.push('- **examples**:');
      for (const ex of def.examples) {
        lines.push(`  - \`${name}(${ex.join(', ')})\``);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
