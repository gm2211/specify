/**
 * src/cli/commands/spec-compile.ts — `specify spec compile`: LLM formula
 * compilation with honest skipping.
 *
 * Compilation is deliberately a separate, offline, browserless verb — NOT
 * part of `verify` (which would make compilation non-deterministic per run,
 * unreviewable, and re-billed on every verification) and NOT part of capture
 * (behaviors get edited by hand after capture, so compiling at capture time
 * would compile against stale prose). Compile once, review the resulting
 * drafts in specify.formulas.yaml, approve them, and every subsequent
 * `verify` run evaluates deterministically for free (src/monitor/evaluate.ts)
 * instead of re-asking an LLM.
 *
 * This module is split into pure, independently-testable pieces (candidate
 * selection, per-result validation, merge-into-file) plus a thin CLI-facing
 * orchestrator (`specCompile`) that wires them to `runSpecifyAgent`. The
 * agent call itself is injectable via `deps.agentRunner` so unit tests can
 * stub the LLM entirely and exercise the validation/merge/idempotence logic
 * deterministically.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { c } from '../colors.js';
import { loadSpec, specToYaml } from '../../spec/parser.js';
import type { Spec } from '../../spec/types.js';
import {
  loadFormulas,
  saveFormulas,
  defaultFormulasPath,
  addDraft,
  hashDescription,
  emptyFormulasFile,
  collectPredicateNames,
  type FormulasFile,
  type FormulaEntry,
  type FormulaProvenance,
} from '../../spec/formulas.js';
import { validateFormula, type Formula } from '../../monitor/formula.js';
import { predicateRegistry, generatePredicateDocs } from '../../monitor/predicates.js';
import { lintFormulas, type LintError } from '../../spec/lint.js';

export interface SpecCompileOptions {
  spec: string;
  /** Repeatable --behavior filter: only compile these fully-qualified ids (still subject to the already-compiled skip unless --force). */
  behavior?: string[];
  /** Recompile behaviors that already have a formula entry. */
  force?: boolean;
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Pure: candidate selection
// ---------------------------------------------------------------------------

export interface CandidateBehavior {
  fqId: string;
  description: string;
}

/** Flatten a spec's areas/behaviors into fully-qualified candidates. */
export function collectAllBehaviors(spec: Spec): CandidateBehavior[] {
  const out: CandidateBehavior[] = [];
  for (const area of spec.areas) {
    for (const behavior of area.behaviors) {
      out.push({ fqId: `${area.id}/${behavior.id}`, description: behavior.description });
    }
  }
  return out;
}

/**
 * Select the behaviors that should be sent to the compiler this run.
 * Without --force, a behavior with ANY existing formula entry (draft,
 * approved, or rejected — a rejected formula still represents "a human
 * looked at this") is excluded, so idempotent re-runs are both cheap (never
 * enter the prompt) and cheap to reason about (no silent duplicate drafts).
 */
export function selectCandidates(
  allBehaviors: CandidateBehavior[],
  existing: FormulasFile | null,
  behaviorFilter: string[] | undefined,
  force: boolean,
): CandidateBehavior[] {
  let candidates = allBehaviors;

  if (behaviorFilter && behaviorFilter.length > 0) {
    const wanted = new Set(behaviorFilter);
    candidates = candidates.filter((b) => wanted.has(b.fqId));
  }

  if (!force && existing) {
    const alreadyCompiled = new Set(existing.formulas.map((f) => f.behavior));
    candidates = candidates.filter((b) => !alreadyCompiled.has(b.fqId));
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Pure: per-result validation
// ---------------------------------------------------------------------------

/** Loosely-typed shape of one `results[]` entry as returned by the model. */
export interface RawCompileResult {
  behavior?: unknown;
  formula?: unknown;
  predicates_used?: unknown;
  rationale?: unknown;
}

/** Loosely-typed shape of one `skipped[]` entry as returned by the model. */
export interface RawSkippedResult {
  behavior?: unknown;
  reason?: unknown;
}

export interface CompileAgentOutput {
  results: RawCompileResult[];
  skipped: RawSkippedResult[];
}

export interface ValidatedCompileResult {
  behavior: string;
  formula: Formula;
  /** AUTHORITATIVE predicate list: derived from the AST via collectPredicateNames, NOT the model's self-report. */
  predicatesUsed: string[];
  rationale: string;
  /**
   * Set when the model's self-reported `predicates_used` did not match the
   * AST-derived set. The entry is still written (with the correct,
   * AST-derived set) — this is surfaced as a stderr note only, so the lint
   * drift-warning stays meaningful for hand-edits to specify.formulas.yaml.
   */
  misreportedPredicates?: { declared: string[]; actual: string[] };
}

export interface RejectedResult {
  behavior: string;
  reason: string;
}

export type CompileValidation =
  | ({ ok: true } & ValidatedCompileResult)
  | ({ ok: false } & RejectedResult);

/** Set equality over two string arrays, ignoring order and duplicates. */
function sameNameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Validate one compiled result: the formula must pass formula.ts's ajv
 * schema, `behavior` must resolve to a behavior actually in the spec, and
 * every predicate actually referenced by the AST must be a known registry
 * name. Invalid entries are rejected, never written.
 *
 * The model's self-reported `predicates_used` is ADVISORY only: the
 * predicate set persisted with the entry is always derived from the AST
 * (collectPredicateNames), so it cannot drift from the formula at the
 * source. A mismatching self-report is surfaced via `misreportedPredicates`
 * (logged to stderr by the caller) but does not reject the entry — the
 * formula itself is what gets reviewed and evaluated, not the report.
 */
export function validateCompileResult(
  raw: RawCompileResult,
  validBehaviors: ReadonlyMap<string, string>,
  predicateNames: ReadonlySet<string>,
): CompileValidation {
  const behavior = typeof raw.behavior === 'string' ? raw.behavior : '';
  if (!behavior) {
    return { ok: false, behavior: '(missing)', reason: 'Missing or non-string "behavior" field' };
  }
  if (!validBehaviors.has(behavior)) {
    return { ok: false, behavior, reason: `"behavior" does not resolve to a behavior in the compiled spec` };
  }

  const { valid, errors } = validateFormula(raw.formula);
  if (!valid) {
    return { ok: false, behavior, reason: `formula failed schema validation: ${errors.join('; ')}` };
  }
  const formula = raw.formula as Formula;

  const actuallyUsed = collectPredicateNames(formula);
  const unknownInFormula = actuallyUsed.filter((p) => !predicateNames.has(p));
  if (unknownInFormula.length > 0) {
    return {
      ok: false,
      behavior,
      reason: `formula references predicate(s) not in the registry: ${unknownInFormula.join(', ')}`,
    };
  }

  const rationale = typeof raw.rationale === 'string' ? raw.rationale : '';

  const declared = Array.isArray(raw.predicates_used)
    ? raw.predicates_used.filter((p): p is string => typeof p === 'string')
    : [];
  const misreported = !sameNameSet(declared, actuallyUsed);

  return {
    ok: true,
    behavior,
    formula,
    predicatesUsed: actuallyUsed,
    rationale,
    ...(misreported ? { misreportedPredicates: { declared, actual: actuallyUsed } } : {}),
  };
}

/** Normalize a skipped-entry, tolerating malformed model output. */
export function normalizeSkipped(raw: RawSkippedResult): RejectedResult | null {
  const behavior = typeof raw.behavior === 'string' ? raw.behavior : '';
  if (!behavior) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '(no reason given)';
  return { behavior, reason };
}

// ---------------------------------------------------------------------------
// Pure: merge into specify.formulas.yaml
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  file: FormulasFile;
  added: FormulaEntry[];
  /** Behaviors whose formula was structurally identical to an existing entry — addDraft dedupes these, no new entry written. */
  deduped: string[];
}

export function mergeCompiledResults(
  file: FormulasFile,
  results: (ValidatedCompileResult & { description: string })[],
  provenanceBase: Omit<FormulaProvenance, 'compiled_at'> & { compiled_at?: string },
): MergeOutcome {
  let current = file;
  const added: FormulaEntry[] = [];
  const deduped: string[] = [];

  for (const r of results) {
    const provenance: FormulaProvenance = {
      compiled_by: provenanceBase.compiled_by,
      compiled_at: provenanceBase.compiled_at ?? new Date().toISOString(),
      ...(provenanceBase.model !== undefined ? { model: provenanceBase.model } : {}),
      ...(provenanceBase.session_id !== undefined ? { session_id: provenanceBase.session_id } : {}),
    };
    const { file: nextFile, entry, deduped: wasDeduped } = addDraft(current, {
      behavior: r.behavior,
      formula: r.formula,
      description_hash: hashDescription(r.description),
      predicates_used: r.predicatesUsed,
      provenance,
    });
    current = nextFile;
    if (wasDeduped) {
      deduped.push(r.behavior);
    } else {
      added.push(entry);
    }
  }

  return { file: current, added, deduped };
}

// ---------------------------------------------------------------------------
// Agent runner (injectable for tests)
// ---------------------------------------------------------------------------

export interface CompileAgentParams {
  specYaml: string;
  predicateDocs: string;
  existingFormulasYaml: string;
  spec: string;
  outputDir: string;
  cwd?: string;
  debug?: boolean;
}

export interface CompileAgentRunResult {
  output: CompileAgentOutput;
  model: string;
  sessionId?: string;
  costUsd: number;
}

export type CompileAgentRunner = (params: CompileAgentParams) => Promise<CompileAgentRunResult>;

function coerceAgentOutput(structuredOutput: unknown): CompileAgentOutput {
  const obj = (structuredOutput ?? {}) as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? (obj.results as RawCompileResult[]) : [];
  const skipped = Array.isArray(obj.skipped) ? (obj.skipped as RawSkippedResult[]) : [];
  return { results, skipped };
}

/**
 * Default agent runner: launches a browserless `runSpecifyAgent` session
 * (task: 'compile' — no url, so sdk-runner.ts skips the Playwright launch
 * entirely) with `getCompilePrompt`'s system prompt. The model string is
 * read back from the run-context.json bundle runSpecifyAgent writes (rather
 * than hard-coded here) so provenance always reflects the model actually
 * used, even if sdk-runner.ts's default changes.
 */
export async function defaultCompileAgentRunner(params: CompileAgentParams): Promise<CompileAgentRunResult> {
  const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
  const { getCompilePrompt } = await import('../../agent/prompts.js');

  const systemPrompt = getCompilePrompt(params.specYaml, params.predicateDocs, params.existingFormulasYaml);

  const { costUsd, structuredOutput, sessionId } = await runSpecifyAgent({
    task: 'compile',
    systemPrompt,
    userPrompt:
      'Compile the behaviors in the spec above into LTLf formulas. Skip anything you cannot compile faithfully — skipping is the correct output, not a failure.',
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
    // Best-effort only — provenance falls back to 'unknown' if unreadable.
  }

  return { output: coerceAgentOutput(structuredOutput), model, sessionId, costUsd };
}

// ---------------------------------------------------------------------------
// CLI-facing orchestrator
// ---------------------------------------------------------------------------

export interface SpecCompileDeps {
  agentRunner?: CompileAgentRunner;
}

/** Map an agent-call failure to an exit code, mirroring src/cli/index.ts's agentExitCode. */
function agentExitCode(err: unknown): number {
  if (err instanceof Error && err.name === 'AgentError') {
    const msg = err.message;
    if (msg.includes('max_turns') || msg.includes('max_budget')) return ExitCode.TIMEOUT;
    if (msg.includes('error_during_execution')) return ExitCode.ASSERTION_FAILURE;
  }
  return ExitCode.NETWORK_ERROR;
}

export async function specCompile(
  options: SpecCompileOptions,
  ctx: CliContext,
  deps: SpecCompileDeps = {},
): Promise<number> {
  if (!options.spec) {
    process.stderr.write('Missing --spec (or run from a directory with an auto-discoverable spec)\n');
    return ExitCode.PARSE_ERROR;
  }
  const resolvedSpec = path.resolve(options.spec);
  if (!fs.existsSync(resolvedSpec)) {
    process.stderr.write(`Spec source not found: ${resolvedSpec}\n`);
    return ExitCode.PARSE_ERROR;
  }

  let spec: Spec;
  try {
    spec = loadSpec(resolvedSpec);
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const formulasPath = defaultFormulasPath(resolvedSpec);
  let existing: FormulasFile | null;
  try {
    existing = loadFormulas(formulasPath);
  } catch (err) {
    process.stderr.write(`Failed to load ${formulasPath}: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const allBehaviors = collectAllBehaviors(spec);

  // --behavior filter ids that don't resolve to any behavior in the spec are
  // almost always typos — warn about each; if NONE resolve, error out rather
  // than silently proceeding (which would otherwise fall through to either
  // "nothing to compile" or, worse, whatever the unfiltered set would be).
  if (options.behavior && options.behavior.length > 0) {
    const specFqIds = new Set(allBehaviors.map((b) => b.fqId));
    const unmatched = options.behavior.filter((id) => !specFqIds.has(id));
    for (const id of unmatched) {
      process.stderr.write(`${c.yellow('Warning:')} --behavior "${id}" does not match any behavior in the spec\n`);
    }
    if (unmatched.length === options.behavior.length) {
      process.stderr.write('None of the provided --behavior ids match a behavior in the spec — nothing to compile.\n');
      if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
        process.stdout.write(JSON.stringify({ error: 'unknown_behavior_filter', unmatched }, null, 2) + '\n');
      }
      return ExitCode.PARSE_ERROR;
    }
  }

  const candidates = selectCandidates(allBehaviors, existing, options.behavior, !!options.force);

  const summaryBase = { formulas_path: formulasPath, candidates: candidates.length };

  if (candidates.length === 0) {
    if (!ctx.quiet) {
      process.stderr.write(
        c.dim('Nothing to compile — all matching behaviors already have a formula entry (use --force to recompile).\n'),
      );
    }
    if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
      process.stdout.write(JSON.stringify({ ...summaryBase, compiled: [], deduped: [], skipped: [], rejected: [], lint: { valid: true, errors: [] } }, null, 2) + '\n');
    }
    return ExitCode.SUCCESS;
  }

  // Build a spec that contains ONLY the candidate behaviors, so
  // already-compiled behaviors never enter the prompt (cheaper, and keeps
  // idempotent re-runs from re-deciding on things a human already reviewed).
  const candidateIds = new Set(candidates.map((b) => b.fqId));
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
  const existingFormulasYaml = yaml.dump(
    existing ?? emptyFormulasFile(),
    { sortKeys: false, lineWidth: 120 },
  );

  const outputDir = path.join(path.dirname(formulasPath), '.specify', 'compile');

  const agentRunner = deps.agentRunner ?? defaultCompileAgentRunner;

  let agentResult: CompileAgentRunResult;
  try {
    agentResult = await agentRunner({
      specYaml,
      predicateDocs,
      existingFormulasYaml,
      spec: resolvedSpec,
      outputDir,
      debug: options.debug,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Compile failed: ${msg}\n`);
    if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
      process.stdout.write(JSON.stringify({ error: 'agent_error', message: msg }) + '\n');
    }
    return agentExitCode(err);
  }

  const predicateNames = new Set(Object.keys(predicateRegistry));
  const behaviorDescByFq = new Map(allBehaviors.map((b) => [b.fqId, b.description] as const));

  const compiledOk: ValidatedCompileResult[] = [];
  const rejected: RejectedResult[] = [];
  for (const raw of agentResult.output.results) {
    const validated = validateCompileResult(raw, behaviorDescByFq, predicateNames);
    if (validated.ok) {
      if (validated.misreportedPredicates) {
        const { declared, actual } = validated.misreportedPredicates;
        process.stderr.write(
          `${c.yellow('Note:')} ${validated.behavior}: model misreported predicates_used ` +
          `(declared: [${declared.join(', ')}], actual from formula: [${actual.join(', ')}]) — writing the AST-derived set\n`,
        );
      }
      compiledOk.push(validated);
    } else {
      rejected.push({ behavior: validated.behavior, reason: validated.reason });
    }
  }

  const skipped = agentResult.output.skipped
    .map((s) => normalizeSkipped(s))
    .filter((s): s is RejectedResult => s !== null);

  const merge = mergeCompiledResults(
    existing ?? emptyFormulasFile(),
    compiledOk.map((r) => ({ ...r, description: behaviorDescByFq.get(r.behavior) ?? '' })),
    {
      compiled_by: 'llm',
      model: agentResult.model,
      ...(agentResult.sessionId ? { session_id: agentResult.sessionId } : {}),
    },
  );

  if (merge.added.length > 0) {
    saveFormulas(formulasPath, merge.file);
  }

  // Self-check: freshly written drafts should lint clean. Only meaningful
  // once something was actually written.
  let lintErrors: LintError[] = [];
  if (merge.added.length > 0) {
    lintErrors = lintFormulas(spec, resolvedSpec, formulasPath, predicateNames);
  }
  const lintValid = !lintErrors.some((e) => e.severity === 'error');

  if (!ctx.quiet) {
    process.stderr.write(`${c.bold('Compile')} ${c.cyan(spec.name)} — ${candidates.length} candidate behavior(s)\n`);
    process.stderr.write(`  ${c.green('compiled:')} ${merge.added.length}\n`);
    for (const e of merge.added) {
      process.stderr.write(`    ${c.dim('+')} ${e.id} ${c.dim(e.behavior)}\n`);
    }
    process.stderr.write(`  ${c.yellow('skipped:')} ${skipped.length}\n`);
    for (const s of skipped) {
      process.stderr.write(`    ${c.dim('-')} ${s.behavior}: ${s.reason}\n`);
    }
    process.stderr.write(`  ${c.red('rejected:')} ${rejected.length}\n`);
    for (const r of rejected) {
      process.stderr.write(`    ${c.dim('x')} ${r.behavior}: ${r.reason}\n`);
    }
    if (merge.deduped.length > 0) {
      process.stderr.write(`  ${c.dim('deduped (identical formula already present):')} ${merge.deduped.length}\n`);
    }
    if (lintErrors.length > 0) {
      process.stderr.write(`  ${c.bold('Self-check (spec lint):')}\n`);
      for (const le of lintErrors) {
        const icon = le.severity === 'error' ? c.red('✗') : c.yellow('⚠');
        process.stderr.write(`    ${icon} ${c.dim(le.path + ':')} ${le.message} ${c.dim(`(${le.rule})`)}\n`);
      }
    } else if (merge.added.length > 0) {
      process.stderr.write(`  ${c.green('✓ lint clean')}\n`);
    }
    process.stderr.write(`\n  ${c.dim('Formulas written as drafts — review and approve in ' + formulasPath)}\n`);
  }

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(JSON.stringify({
      ...summaryBase,
      compiled: merge.added.map((e) => ({ id: e.id, behavior: e.behavior })),
      deduped: merge.deduped,
      skipped,
      rejected,
      lint: { valid: lintValid, errors: lintErrors },
      cost_usd: agentResult.costUsd,
    }, null, 2) + '\n');
  }

  return lintValid ? ExitCode.SUCCESS : ExitCode.ASSERTION_FAILURE;
}
