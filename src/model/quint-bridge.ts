/**
 * src/model/quint-bridge.ts — Bridge a decoded ITF trace (src/model/quint-itf.ts)
 * into the existing trace-to-Playwright pipeline (SP-i35).
 *
 * A hand-modeled Quint spec is written over the SAME grounded predicate
 * vocabulary as the trace monitors (src/monitor/predicates.ts) — one grounding
 * layer serving both. `quint run` simulates that spec and emits ITF traces; this
 * module adapts each ITF trace into the `CompiledStep` / `CompiledAssertion`
 * substrate the deterministic-compilation pass (src/model/trace-compiler.ts)
 * already produces from inferred-model mutation variants, and reuses that
 * module's step lowering (`renderStep`) and URL-template matcher
 * (`urlTemplateToRegex`) so a Quint-sourced trace renders the exact same
 * reviewable Playwright artifact as an inferred-model one. Nothing new is added
 * to the executable substrate — the bridge is purely an adapter.
 *
 * THE CONVENTION (how a Quint state describes a browser step)
 * ----------------------------------------------------------------------------
 * ITF is variable-agnostic, so the bridge reads a small, documented set of
 * per-state fields (names overridable via `QuintBridgeConvention`):
 *
 *   - `action`   (string)  — the browser op that TRANSITIONED INTO this state,
 *                            e.g. "browser_goto", "browser_click". The initial
 *                            state (index 0) has no producing action; its action
 *                            field, if any, is ignored (it seeds the entry nav).
 *   - `selector` (string)  — CSS selector the action carried, when applicable.
 *   - `value`    (string)  — navigation/fill value, when applicable.
 *   - `url`      (string)  — the URL template the flow is on in this state. The
 *                            initial state's `url` is the entry navigation
 *                            target; the final state's `url` is the destination
 *                            URL-template assertion.
 *   - `predicates`         — grounded predicate bits expected to hold in this
 *                            state, as either a plain record `{name: bool}` or an
 *                            ITF map `{name → bool}` (Quint models predicate
 *                            names — which contain dots — as map keys, since a
 *                            dotted name is not a valid Quint identifier). The
 *                            FINAL state's predicate bits become the
 *                            destination-state predicate assertion.
 *
 * GROUNDING CHECK
 * ----------------------------------------------------------------------------
 * Every predicate name a state names is checked against the shared registry
 * (`predicateRegistry`). An unknown name is a GROUNDING problem — the spec drew
 * a predicate the monitor vocabulary does not ground — and is reported in
 * `ungroundedPredicates`, NOT silently dropped and NOT treated as an assertion
 * failure, mirroring the epic's grounding-vs-assertion split. The bridge never
 * throws.
 */

import type { CompiledStep, CompiledAssertion } from './trace-compiler.js';
import { renderStep, urlTemplateToRegex } from './trace-compiler.js';
import type { ItfState, ItfValue, ItfTrace } from './quint-itf.js';
import { predicateRegistry } from '../monitor/predicates.js';

// ---------------------------------------------------------------------------
// Convention
// ---------------------------------------------------------------------------

/** Field-name overrides for reading a browser step out of an ITF state. */
export interface QuintBridgeConvention {
  actionField?: string;
  selectorField?: string;
  valueField?: string;
  urlField?: string;
  predicatesField?: string;
}

interface ResolvedConvention {
  action: string;
  selector: string;
  value: string;
  url: string;
  predicates: string;
}

function resolveConvention(c: QuintBridgeConvention = {}): ResolvedConvention {
  return {
    action: c.actionField ?? 'action',
    selector: c.selectorField ?? 'selector',
    value: c.valueField ?? 'value',
    url: c.urlField ?? 'url',
    predicates: c.predicatesField ?? 'predicates',
  };
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function readString(state: ItfState, field: string): string | undefined {
  const v = state[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Read a state's predicate bits from either a plain record `{name: bool}` or an
 * ITF map `{ map: [[name, bool], …] }`. Non-boolean values and non-string keys
 * are skipped. Returns the flat name→bool record.
 */
export function readPredicateBits(state: ItfState, field: string): Record<string, boolean> {
  const raw = state[field];
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object') return out;

  if (Array.isArray(raw)) return out;

  if ('map' in raw && Array.isArray((raw as { map: unknown }).map)) {
    for (const pair of (raw as { map: Array<[ItfValue, ItfValue]> }).map) {
      const [k, val] = pair;
      if (typeof k === 'string' && typeof val === 'boolean') out[k] = val;
    }
    return out;
  }

  for (const [k, val] of Object.entries(raw as Record<string, ItfValue>)) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bridged script
// ---------------------------------------------------------------------------

/**
 * A Quint-sourced trace lowered into the shared executable substrate. Uses the
 * exact `CompiledStep` / `CompiledAssertion` shapes trace-compiler.ts produces,
 * so a downstream executor / reviewer treats it identically to an inferred-model
 * script — the only difference is provenance (`source: 'quint'`).
 */
export interface QuintTraceScript {
  version: 1;
  source: 'quint';
  /** Stable id for this bridged trace (e.g. `${flow}~quint~${ordinal}`). */
  id: string;
  /** The flow this trace exercises (fully-qualified area-id/behavior-id). */
  flow: string;
  /** Leading navigation to the initial state's URL (index -1). */
  entry: CompiledStep;
  /** One CompiledStep per transition into a non-initial state. */
  steps: CompiledStep[];
  /** Destination-state assertions (final URL template + final predicate bits). */
  assertions: CompiledAssertion[];
  /** Predicate names the spec used that the grounded registry does NOT define. Sorted, deduped. */
  ungroundedPredicates: string[];
  /** The rendered, reviewable Playwright test source. Deterministic. */
  playwright: string;
}

export interface BridgeOptions {
  /** Id prefix for the generated script; default the flow id. */
  idPrefix?: string;
  /** Ordinal appended to the id (for multiple traces of one flow). Default 0. */
  ordinal?: number;
  convention?: QuintBridgeConvention;
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/** Collect every predicate name across all states that the registry does not ground. */
function collectUngrounded(states: ItfState[], predicatesField: string): string[] {
  const seen = new Set<string>();
  for (const state of states) {
    const bits = readPredicateBits(state, predicatesField);
    for (const name of Object.keys(bits)) {
      if (!(name in predicateRegistry)) seen.add(name);
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Adapt one decoded ITF trace into a `QuintTraceScript`. Pure and deterministic
 * given `(trace, flow, options)`. A trace with zero states yields an
 * entry-only script that navigates nowhere-in-particular ('/'), so the output is
 * always well-formed; the caller can detect the empty case via `steps.length`.
 */
export function bridgeItfTrace(
  trace: ItfTrace,
  flow: string,
  options: BridgeOptions = {},
): QuintTraceScript {
  const conv = resolveConvention(options.convention);
  const ordinal = options.ordinal ?? 0;
  const id = `${options.idPrefix ?? flow}~quint~${ordinal}`;
  const states = trace.states;

  const initial = states[0];
  const entry: CompiledStep = {
    index: -1,
    source: 'entry',
    action: 'browser_goto',
    value: initial ? readString(initial, conv.url) ?? '/' : '/',
    intendedLandsOn: initial ? readString(initial, conv.url) : undefined,
    note: 'enter at initial state',
  };

  const steps: CompiledStep[] = [];
  for (let i = 1; i < states.length; i++) {
    const state = states[i];
    const action = readString(state, conv.action) ?? 'browser_goto';
    const step: CompiledStep = {
      index: i - 1,
      source: 'model',
      action,
      selector: readString(state, conv.selector),
      value: readString(state, conv.value) ?? readString(state, conv.url),
      intendedLandsOn: readString(state, conv.url),
      note: `quint step ${i}: ${action}`,
    };
    steps.push(step);
  }

  const assertions: CompiledAssertion[] = [];
  const finalState = states[states.length - 1];
  if (finalState) {
    const finalUrl = readString(finalState, conv.url);
    if (finalUrl) {
      assertions.push({ kind: 'url-template', stateId: `state-${states.length - 1}`, urlTemplate: finalUrl });
    }
    const finalBits = readPredicateBits(finalState, conv.predicates);
    // Only ground predicate names survive into an assertion; ungrounded names
    // are reported separately, never asserted.
    const grounded: Record<string, boolean> = {};
    for (const [name, val] of Object.entries(finalBits)) {
      if (name in predicateRegistry) grounded[name] = val;
    }
    if (Object.keys(grounded).length > 0) {
      assertions.push({ kind: 'predicate', stateId: `state-${states.length - 1}`, predicates: grounded });
    }
  }

  const ungroundedPredicates = collectUngrounded(states, conv.predicates);

  const script: QuintTraceScript = {
    version: 1,
    source: 'quint',
    id,
    flow,
    entry,
    steps,
    assertions,
    ungroundedPredicates,
    playwright: '',
  };
  script.playwright = renderQuintPlaywright(script);
  return script;
}

// ---------------------------------------------------------------------------
// Playwright rendering — reuses trace-compiler's step lowering
// ---------------------------------------------------------------------------

/**
 * Render a `QuintTraceScript` into a deterministic Playwright test. Reuses
 * trace-compiler.ts's `renderStep` for the action→statement lowering (single
 * source of truth) and `urlTemplateToRegex` for the destination-URL assertion,
 * so a Quint-sourced test reads identically to an inferred-model one.
 */
export function renderQuintPlaywright(script: QuintTraceScript): string {
  const needsContext = [script.entry, ...script.steps].some((s) => s.action === 'browser_clear_cookies');
  const fixtures = needsContext ? '{ page, context }' : '{ page }';
  const title = `${script.id}: ${script.flow}`;

  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`// source: quint (hand-modeled spec) — flow=${script.flow}`);
  if (script.ungroundedPredicates.length > 0) {
    lines.push(
      `// WARNING: ${script.ungroundedPredicates.length} ungrounded predicate(s) in the spec were not asserted: ${script.ungroundedPredicates.join(', ')}`,
    );
  }
  lines.push(`test(${jsQuote(title)}, async (${fixtures}) => {`);
  lines.push(renderStep(script.entry));
  for (const step of script.steps) lines.push(renderStep(step));

  const urlAssertion = script.assertions.find((a) => a.kind === 'url-template');
  if (urlAssertion && urlAssertion.kind === 'url-template') {
    lines.push('');
    lines.push(`  // destination-state assertion (from the spec's final state)`);
    lines.push(
      `  await expect(page).toHaveURL(new RegExp(${jsQuote(urlTemplateToRegex(urlAssertion.urlTemplate))}));`,
    );
  }
  const predAssertion = script.assertions.find((a) => a.kind === 'predicate');
  if (predAssertion && predAssertion.kind === 'predicate') {
    lines.push(`  // expected grounded predicates: ${JSON.stringify(predAssertion.predicates)}`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

/** Escape a string for a single-quoted JS literal (local copy to keep the bridge self-contained). */
function jsQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}
