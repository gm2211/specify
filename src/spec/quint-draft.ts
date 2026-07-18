/**
 * src/spec/quint-draft.ts — `draftQuintSpecs`: LLM drafting of hand-modeled
 * Quint specs for critical flows (SP-i35), mirroring src/cli/commands/
 * spec-compile.ts's structure.
 *
 * Drafting is a deliberately separate, offline, browserless verb — NOT part of
 * verify or capture. An LLM reads the spec's behavior narratives and, for the
 * FEW flows that warrant a formal model (auth, checkout), drafts a Quint (`.qnt`)
 * module over the shared grounded predicate vocabulary. Because there is no
 * published evidence that LLM-authored specs in this language are reliable, the
 * result is written as a DRAFT into specify.quint.yaml (src/spec/quint-specs.ts)
 * and is inert until a human reviews and approves it — the same
 * draft/human-approve gate the formula compiler uses.
 *
 * This module is opt-in: the whole surface is behind `quintSpecsEnabled()`, and
 * it is split into pure, independently-testable pieces (candidate selection,
 * per-result validation, merge-into-file) plus a thin orchestrator that wires
 * them to an injectable agent runner so tests stub the LLM entirely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { Spec } from './types.js';
import { specToYaml } from './parser.js';
import {
  loadQuintSpecs,
  saveQuintSpecs,
  defaultQuintSpecsPath,
  addQuintDraft,
  hashNarrative,
  emptyQuintSpecsFile,
  type QuintSpecsFile,
  type QuintSpecEntry,
  type QuintSpecProvenance,
} from './quint-specs.js';
import { predicateRegistry, generatePredicateDocs } from '../monitor/predicates.js';
import { quintSpecsEnabled } from '../agent/feature-flags.js';

// ---------------------------------------------------------------------------
// Pure: candidate selection
// ---------------------------------------------------------------------------

export interface CandidateFlow {
  fqId: string;
  description: string;
}

/** Flatten a spec's areas/behaviors into fully-qualified candidate flows. */
export function collectAllFlows(spec: Spec): CandidateFlow[] {
  const out: CandidateFlow[] = [];
  for (const area of spec.areas) {
    for (const behavior of area.behaviors) {
      out.push({ fqId: `${area.id}/${behavior.id}`, description: behavior.description });
    }
  }
  return out;
}

/**
 * Select the flows to send to the drafter. Without `force`, a flow that already
 * has ANY spec entry (draft, approved, or rejected — a human already looked) is
 * excluded, so re-runs are idempotent and never silently duplicate a draft.
 */
export function selectFlowCandidates(
  allFlows: CandidateFlow[],
  existing: QuintSpecsFile | null,
  flowFilter: string[] | undefined,
  force: boolean,
): CandidateFlow[] {
  let candidates = allFlows;

  if (flowFilter && flowFilter.length > 0) {
    const wanted = new Set(flowFilter);
    candidates = candidates.filter((f) => wanted.has(f.fqId));
  }

  if (!force && existing) {
    const alreadyDrafted = new Set(existing.specs.map((s) => s.flow));
    candidates = candidates.filter((f) => !alreadyDrafted.has(f.fqId));
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pure: per-result validation
// ---------------------------------------------------------------------------

export interface RawDraftResult {
  flow?: unknown;
  spec_text?: unknown;
  predicates_used?: unknown;
  rationale?: unknown;
}

export interface RawSkippedFlow {
  flow?: unknown;
  reason?: unknown;
}

export interface DraftAgentOutput {
  results: RawDraftResult[];
  skipped: RawSkippedFlow[];
}

export interface ValidatedDraftResult {
  flow: string;
  specText: string;
  /** Predicate names, filtered to those actually in the shared registry. */
  predicatesUsed: string[];
  rationale: string;
  /** Names the model self-reported that the registry does NOT ground (surfaced, not fatal). */
  ungroundedPredicates?: string[];
}

export interface RejectedFlow {
  flow: string;
  reason: string;
}

export type DraftValidation =
  | ({ ok: true } & ValidatedDraftResult)
  | ({ ok: false } & RejectedFlow);

/**
 * Validate one drafted result: `flow` must resolve to a real behavior, and
 * `spec_text` must be present and non-trivial (a Quint module needs at least a
 * `module` declaration). The self-reported `predicates_used` is filtered to the
 * grounded registry; ungrounded names are surfaced but do NOT reject the draft
 * (a human reviews the model, and the bridge re-checks grounding at execution
 * time) — the point of the gate is human review, not machine certification.
 */
export function validateDraftResult(
  raw: RawDraftResult,
  validFlows: ReadonlySet<string>,
  predicateNames: ReadonlySet<string>,
): DraftValidation {
  const flow = typeof raw.flow === 'string' ? raw.flow : '';
  if (!flow) {
    return { ok: false, flow: '(missing)', reason: 'Missing or non-string "flow" field' };
  }
  if (!validFlows.has(flow)) {
    return { ok: false, flow, reason: '"flow" does not resolve to a behavior in the spec' };
  }

  const specText = typeof raw.spec_text === 'string' ? raw.spec_text.trim() : '';
  if (!specText) {
    return { ok: false, flow, reason: 'Missing or empty "spec_text"' };
  }
  if (!/\bmodule\b/.test(specText)) {
    return { ok: false, flow, reason: 'spec_text does not look like a Quint module (no "module" declaration)' };
  }

  const declared = Array.isArray(raw.predicates_used)
    ? raw.predicates_used.filter((p): p is string => typeof p === 'string')
    : [];
  const grounded = declared.filter((p) => predicateNames.has(p));
  const ungrounded = declared.filter((p) => !predicateNames.has(p));

  const rationale = typeof raw.rationale === 'string' ? raw.rationale : '';

  return {
    ok: true,
    flow,
    specText,
    predicatesUsed: grounded,
    rationale,
    ...(ungrounded.length > 0 ? { ungroundedPredicates: ungrounded } : {}),
  };
}

/** Normalize a skipped entry, tolerating malformed model output. */
export function normalizeSkippedFlow(raw: RawSkippedFlow): RejectedFlow | null {
  const flow = typeof raw.flow === 'string' ? raw.flow : '';
  if (!flow) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '(no reason given)';
  return { flow, reason };
}

// ---------------------------------------------------------------------------
// Pure: merge into specify.quint.yaml
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  file: QuintSpecsFile;
  added: QuintSpecEntry[];
  /** Flows whose drafted spec was byte-identical to an existing entry (deduped). */
  deduped: string[];
}

export function mergeDraftResults(
  file: QuintSpecsFile,
  results: (ValidatedDraftResult & { description: string })[],
  provenanceBase: Omit<QuintSpecProvenance, 'drafted_at'> & { drafted_at?: string },
): MergeOutcome {
  let current = file;
  const added: QuintSpecEntry[] = [];
  const deduped: string[] = [];

  for (const r of results) {
    const provenance: QuintSpecProvenance = {
      drafted_by: provenanceBase.drafted_by,
      drafted_at: provenanceBase.drafted_at ?? new Date().toISOString(),
      ...(provenanceBase.model !== undefined ? { model: provenanceBase.model } : {}),
      ...(provenanceBase.session_id !== undefined ? { session_id: provenanceBase.session_id } : {}),
    };
    const { file: nextFile, entry, deduped: wasDeduped } = addQuintDraft(current, {
      flow: r.flow,
      spec_text: r.specText,
      description_hash: hashNarrative(r.description),
      predicates_used: r.predicatesUsed,
      provenance,
    });
    current = nextFile;
    if (wasDeduped) deduped.push(r.flow);
    else added.push(entry);
  }

  return { file: current, added, deduped };
}

// ---------------------------------------------------------------------------
// Agent runner (injectable for tests)
// ---------------------------------------------------------------------------

export interface DraftAgentParams {
  specYaml: string;
  predicateDocs: string;
  existingQuintYaml: string;
  spec: string;
  outputDir: string;
  cwd?: string;
  debug?: boolean;
}

export interface DraftAgentRunResult {
  output: DraftAgentOutput;
  model: string;
  sessionId?: string;
  costUsd: number;
}

export type DraftAgentRunner = (params: DraftAgentParams) => Promise<DraftAgentRunResult>;

function coerceAgentOutput(structuredOutput: unknown): DraftAgentOutput {
  const obj = (structuredOutput ?? {}) as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? (obj.results as RawDraftResult[]) : [];
  const skipped = Array.isArray(obj.skipped) ? (obj.skipped as RawSkippedFlow[]) : [];
  return { results, skipped };
}

/**
 * Default agent runner: launches a browserless `runSpecifyAgent` session
 * (task: 'quint-draft' — no url, so sdk-runner skips the Playwright launch)
 * with `getQuintDraftPrompt`'s system prompt. The model string is read back
 * from run-context.json so provenance reflects the model actually used.
 */
export async function defaultDraftAgentRunner(params: DraftAgentParams): Promise<DraftAgentRunResult> {
  const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
  const { getQuintDraftPrompt } = await import('../agent/prompts.js');

  const systemPrompt = getQuintDraftPrompt(params.specYaml, params.predicateDocs, params.existingQuintYaml);

  const { costUsd, structuredOutput, sessionId } = await runSpecifyAgent({
    task: 'quint-draft',
    systemPrompt,
    userPrompt:
      'Draft Quint models for the critical flows in the spec above. Model only the few flows that warrant a hand-written formal spec; skip the rest with an honest reason. Every draft is reviewed by a human before use.',
    spec: params.spec,
    outputDir: params.outputDir,
    cwd: params.cwd,
    debug: params.debug,
  });

  let model = 'unknown';
  try {
    const bundlePath = path.join(params.outputDir, 'run-context.json');
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8')) as { model?: string };
    if (typeof bundle.model === 'string' && bundle.model) model = bundle.model;
  } catch {
    // Best-effort — provenance falls back to 'unknown' if unreadable.
  }

  return { output: coerceAgentOutput(structuredOutput), model, sessionId, costUsd };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface DraftQuintOptions {
  spec: string;
  /** Repeatable flow filter: only draft these fully-qualified ids. */
  flow?: string[];
  /** Re-draft flows that already have a spec entry. */
  force?: boolean;
  debug?: boolean;
}

export interface DraftQuintDeps {
  agentRunner?: DraftAgentRunner;
}

export interface DraftQuintSummary {
  quintPath: string;
  /** Reason drafting did not run (flag off, no spec, load error, nothing to draft). */
  skippedReason?: string;
  candidates: number;
  added: { id: string; flow: string }[];
  deduped: string[];
  skipped: RejectedFlow[];
  rejected: RejectedFlow[];
  ungrounded: { flow: string; predicates: string[] }[];
  costUsd?: number;
}

/**
 * Draft Quint specs for a spec's critical flows and write the drafts to
 * specify.quint.yaml. Returns a structured summary rather than an exit code so
 * a caller (a future CLI verb, or a test) can render it however it likes. The
 * whole surface is gated: with `quintSpecsEnabled()` off, this is a no-op that
 * reports `skippedReason`. Never throws for expected conditions.
 */
export async function draftQuintSpecs(
  options: DraftQuintOptions,
  deps: DraftQuintDeps = {},
): Promise<DraftQuintSummary> {
  const resolvedSpec = path.resolve(options.spec);
  const quintPath = defaultQuintSpecsPath(resolvedSpec);
  const base: DraftQuintSummary = {
    quintPath,
    candidates: 0,
    added: [],
    deduped: [],
    skipped: [],
    rejected: [],
    ungrounded: [],
  };

  if (!quintSpecsEnabled()) {
    return { ...base, skippedReason: 'SPECIFY_ENABLE_QUINT_SPECS is not set — Quint integration is opt-in' };
  }
  if (!fs.existsSync(resolvedSpec)) {
    return { ...base, skippedReason: `Spec source not found: ${resolvedSpec}` };
  }

  const { loadSpec } = await import('./parser.js');
  let spec: Spec;
  try {
    spec = loadSpec(resolvedSpec);
  } catch (err) {
    return { ...base, skippedReason: `Failed to load spec: ${(err as Error).message}` };
  }

  let existing: QuintSpecsFile | null;
  try {
    existing = loadQuintSpecs(quintPath);
  } catch (err) {
    return { ...base, skippedReason: `Failed to load ${quintPath}: ${(err as Error).message}` };
  }

  const allFlows = collectAllFlows(spec);
  const candidates = selectFlowCandidates(allFlows, existing, options.flow, !!options.force);
  if (candidates.length === 0) {
    return { ...base, skippedReason: 'Nothing to draft — all matching flows already have a Quint spec entry (use force to re-draft)' };
  }

  // Send ONLY the candidate flows to the drafter.
  const candidateIds = new Set(candidates.map((f) => f.fqId));
  const filteredSpec: Spec = {
    ...spec,
    areas: spec.areas
      .map((area) => ({
        ...area,
        behaviors: area.behaviors.filter((b) => candidateIds.has(`${area.id}/${b.id}`)),
      }))
      .filter((area) => area.behaviors.length > 0),
  };

  const specYaml = specToYaml(filteredSpec);
  const predicateDocs = generatePredicateDocs(predicateRegistry);
  const existingQuintYaml = yaml.dump(existing ?? emptyQuintSpecsFile(), { sortKeys: false, lineWidth: 120 });
  const outputDir = path.join(path.dirname(quintPath), '.specify', 'quint-draft');

  const agentRunner = deps.agentRunner ?? defaultDraftAgentRunner;
  let agentResult: DraftAgentRunResult;
  try {
    agentResult = await agentRunner({ specYaml, predicateDocs, existingQuintYaml, spec: resolvedSpec, outputDir, debug: options.debug });
  } catch (err) {
    return { ...base, candidates: candidates.length, skippedReason: `Draft agent failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const predicateNames = new Set(Object.keys(predicateRegistry));
  const validFlows = new Set(allFlows.map((f) => f.fqId));
  const descByFq = new Map(allFlows.map((f) => [f.fqId, f.description] as const));

  const okResults: ValidatedDraftResult[] = [];
  const rejected: RejectedFlow[] = [];
  const ungrounded: { flow: string; predicates: string[] }[] = [];
  for (const raw of agentResult.output.results) {
    const validated = validateDraftResult(raw, validFlows, predicateNames);
    if (validated.ok) {
      okResults.push(validated);
      if (validated.ungroundedPredicates && validated.ungroundedPredicates.length > 0) {
        ungrounded.push({ flow: validated.flow, predicates: validated.ungroundedPredicates });
      }
    } else {
      rejected.push({ flow: validated.flow, reason: validated.reason });
    }
  }

  const skipped = agentResult.output.skipped
    .map((s) => normalizeSkippedFlow(s))
    .filter((s): s is RejectedFlow => s !== null);

  const merge = mergeDraftResults(
    existing ?? emptyQuintSpecsFile(),
    okResults.map((r) => ({ ...r, description: descByFq.get(r.flow) ?? '' })),
    {
      drafted_by: 'llm',
      model: agentResult.model,
      ...(agentResult.sessionId ? { session_id: agentResult.sessionId } : {}),
    },
  );

  if (merge.added.length > 0) {
    saveQuintSpecs(quintPath, merge.file);
  }

  return {
    quintPath,
    candidates: candidates.length,
    added: merge.added.map((e) => ({ id: e.id, flow: e.flow })),
    deduped: merge.deduped,
    skipped,
    rejected,
    ungrounded,
    costUsd: agentResult.costUsd,
  };
}
