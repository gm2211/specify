/**
 * src/agent/trace-executor.ts — Scripted-first execution of compiled adversarial
 * trace variants, with agent-driven fallback on grounding drift + three-outcome
 * contract evaluation (SP-w5d).
 *
 * The compiler (src/model/trace-compiler.ts) lowers each mutation variant into a
 * deterministic `CompiledScript`. This module RUNS them:
 *
 *  1. SCRIPTED-FIRST. Drive each compiled step against the live target through
 *     an injectable `StepDriver`, capturing the two signals the model already
 *     records — network signatures and page predicates — after each step.
 *
 *  2. AGENT-FIRST FALLBACK on a GROUNDING failure. A step that cannot execute at
 *     all (selector gone, state drifted, navigation failed) is a GROUNDING
 *     failure, NOT an assertion failure. When one occurs the whole trace is
 *     re-executed once agent-driven, with the trace as the instruction. If the
 *     agent grounds it, the recipe is re-recorded (a maintenance signal) and the
 *     contract is evaluated against the agent-captured signals; if the agent
 *     also fails to ground it, the variant is reported as a GROUNDING GAP — a
 *     category strictly separate from an assertion failure, feeding model /
 *     vocabulary maintenance and NEVER reported as an application bug.
 *
 *  3. CONTRACT EVALUATION with the three-outcome discipline. `evaluateContract`
 *     is a pure function of the variant's contract + the captured signals,
 *     returning pass / violation / inconclusive. Contracts are CONSERVATIVE: a
 *     correct app is never flagged. Ambiguity (missing or unreadable signal)
 *     resolves to INCONCLUSIVE, and a repeated 2xx write is inconclusive rather
 *     than a violation unless duplication was independently corroborated.
 *
 * The pure logic — the execute loop's grounding-vs-assertion decision, the
 * fallback trigger, and the whole contract matrix — is injectable and unit-
 * tested with fakes, mirroring how test-runner.ts splits `decideConfirmation`
 * out from the live process spawn. The live `StepDriver` / `AgentFallback`
 * implementations are thin adapters over the browser command surface and the
 * SDK runner; they are wired at the call site, not here.
 */

import type { NetworkSignatureEntry } from '../model/nav-model.js';
import type {
  Contract,
  ContractCheck,
  ContractClass,
  MutationOperatorName,
} from '../model/mutators.js';
import type { CompiledScript, CompiledStep, ContractRefs } from '../model/trace-compiler.js';
import { isWriteEntry } from '../model/trace-compiler.js';

// ---------------------------------------------------------------------------
// Captured signals
// ---------------------------------------------------------------------------

/** Signals captured after executing one step against the live target. */
export interface CapturedStep {
  /** Mirrors `CompiledStep.index` (source-step position; -1 for entry nav). */
  index: number;
  action: string;
  /**
   * 'ok'                = the step grounded and executed.
   * 'grounding-failure' = the step could NOT execute (selector gone, nav
   *                       failed, state drifted) — a grounding gap, never an
   *                       app bug.
   */
  outcome: 'ok' | 'grounding-failure';
  /** Reason string, present when `outcome` is 'grounding-failure'. */
  reason?: string;
  /** The model state this step was expected to land on (from compilation). */
  intendedLandsOn?: string;
  /** Live URL after the step. */
  url?: string;
  /** Live page predicate bits observed after the step. */
  predicates?: Record<string, boolean>;
  /** Network signature entries the step produced. */
  network?: NetworkSignatureEntry[];
}

/** The full captured run of one variant. */
export interface CapturedTrace {
  entry: CapturedStep;
  steps: CapturedStep[];
  /**
   * Optional corroboration channel: an independent probe (e.g. a later
   * list/read) confirmed a side effect was actually duplicated. A repeated 2xx
   * write is only a VIOLATION when this is true — status alone is inconclusive.
   */
  duplicationCorroborated?: boolean;
}

// ---------------------------------------------------------------------------
// Drivers (injectable)
// ---------------------------------------------------------------------------

/**
 * Drives a single compiled step against the live target and captures its
 * signals. MUST never throw — a thrown error is a driver contract violation, not
 * a grounding failure; implementations catch and return a 'grounding-failure'
 * capture instead so the executor can categorize it correctly.
 */
export interface StepDriver {
  runStep(step: CompiledStep): Promise<CapturedStep>;
}

/** The agent's re-execution of a whole trace after a scripted grounding failure. */
export interface AgentFallbackOutcome {
  /** Did the agent manage to ground (execute) the whole trace? */
  grounded: boolean;
  /** Signals the agent captured, when it grounded the trace. */
  captured?: CapturedTrace;
  /** A re-recorded recipe hint for the drifted step, cached for future runs. */
  reRecorded?: { stepIndex: number; note: string };
  /** Reason the agent could not ground the trace (grounding gap). */
  reason?: string;
}

/**
 * Re-executes a variant agent-driven after a scripted grounding failure, with
 * the trace as the instruction. Injectable so the fallback policy is testable
 * without an LLM. MUST never throw (same contract as `StepDriver`).
 */
export interface AgentFallback {
  runTrace(script: CompiledScript, failedStepIndex: number): Promise<AgentFallbackOutcome>;
}

// ---------------------------------------------------------------------------
// Contract evaluation — the three-outcome matrix (pure)
// ---------------------------------------------------------------------------

/** The three-outcome verdict. Contracts are conservative: ambiguity ⇒ inconclusive. */
export type ContractVerdict = 'pass' | 'violation' | 'inconclusive';

export interface ContractEvaluation {
  verdict: ContractVerdict;
  /** Human-readable evidence lines backing the verdict. */
  evidence: string[];
}

/** Does a captured network list contain an entry matching one of `writes`? */
function matchWrite(
  network: NetworkSignatureEntry[] | undefined,
  writes: NetworkSignatureEntry[],
): NetworkSignatureEntry | undefined {
  if (!network) return undefined;
  return network.find((e) =>
    writes.some(
      (w) => w.method.toUpperCase() === e.method.toUpperCase() && w.urlTemplate === e.urlTemplate,
    ),
  );
}

/** Any side-effecting (write-method) entry in a captured network list. */
function anyWrite(network: NetworkSignatureEntry[] | undefined): NetworkSignatureEntry | undefined {
  return network?.find(isWriteEntry);
}

/** Any redirect (3xx) entry in a captured network list. */
function anyRedirect(network: NetworkSignatureEntry[] | undefined): boolean {
  return !!network?.some((e) => e.statusClass === '3xx');
}

/** Locate a captured step by its source-step index (entry nav is index -1). */
function stepAt(captured: CapturedTrace, index: number): CapturedStep | undefined {
  if (index < 0) return captured.entry;
  return captured.steps.find((s) => s.index === index);
}

/**
 * Grounding-failure rule for the re-fire step: a failure is only inconclusive
 * when it happened BEFORE the request was issued (no network signature was
 * recorded for the step). A failure AFTER issue (e.g. a timeout mid-request,
 * with traffic recorded) could hide a real second write, so the recorded
 * traffic IS evaluated — the request left the browser regardless of whether the
 * step "completed".
 */
function evalNoRepeatedWrite(
  check: Extract<ContractCheck, { kind: 'no-repeated-write' }>,
  captured: CapturedTrace,
): ContractEvaluation {
  const step = stepAt(captured, check.injectedStepIndex);
  if (!step) {
    return {
      verdict: 'inconclusive',
      evidence: [
        `re-fire step ${check.injectedStepIndex} has no captured record — cannot judge a second side effect`,
      ],
    };
  }
  const requestIssued = (step.network?.length ?? 0) > 0;
  if (step.outcome !== 'ok' && !requestIssued) {
    return {
      verdict: 'inconclusive',
      evidence: [
        `re-fire step ${check.injectedStepIndex} failed before any request was issued (no traffic recorded) — cannot judge a second side effect`,
      ],
    };
  }
  const failedMidRequest = step.outcome !== 'ok' && requestIssued;
  const midRequestNote = failedMidRequest
    ? [
        `re-fire step ${check.injectedStepIndex} failed AFTER traffic was recorded (${step.reason ?? 'mid-request failure'}) — evaluating the recorded traffic, since the request left the browser`,
      ]
    : [];
  const observed = matchWrite(step.network, check.write);
  if (!observed) {
    // A mid-request failure with traffic recorded but no MATCHING write still
    // cannot rule out the write having fired unrecorded — stay inconclusive.
    if (failedMidRequest) {
      return {
        verdict: 'inconclusive',
        evidence: [
          ...midRequestNote,
          `no matching write appears in the recorded traffic, but the step failed mid-flight — cannot rule out a second side effect`,
        ],
      };
    }
    return {
      verdict: 'pass',
      evidence: [`re-fire produced no matching write request — no second side effect fired`],
    };
  }
  const status = observed.statusClass;
  if (status === '4xx' || status === '5xx') {
    return {
      verdict: 'pass',
      evidence: [
        ...midRequestNote,
        `second ${observed.method} ${observed.urlTemplate} rejected/absorbed (${status}) — server-side dedup visible`,
      ],
    };
  }
  if (status === '2xx') {
    if (captured.duplicationCorroborated) {
      return {
        verdict: 'violation',
        evidence: [
          ...midRequestNote,
          `second ${observed.method} ${observed.urlTemplate} returned 2xx AND duplication was corroborated — a real second side effect`,
        ],
      };
    }
    return {
      verdict: 'inconclusive',
      evidence: [
        ...midRequestNote,
        `second ${observed.method} ${observed.urlTemplate} returned 2xx with no corroboration — idempotent retry vs duplicate is indistinguishable from status alone`,
      ],
    };
  }
  return {
    verdict: 'inconclusive',
    evidence: [
      ...midRequestNote,
      `second ${observed.method} ${observed.urlTemplate} returned ${status} — not a decisive signal`,
    ],
  };
}

function evalAuthRedirect(
  check: Extract<ContractCheck, { kind: 'expect-auth-redirect' }>,
  captured: CapturedTrace,
  refs: ContractRefs,
): ContractEvaluation {
  const authSet = new Set(check.authStates);
  const authTemplates = new Set(check.authStates.map((s) => refs.urlTemplates[s]).filter(Boolean));
  // Malformed capture must degrade LOUDLY, not silently: a step in the checked
  // window whose intendedLandsOn is missing might have been an auth-targeting
  // step we can no longer attribute. Count them; if any exist, the check can
  // never PASS on the surviving steps alone (a violation found on real
  // evidence still stands).
  const inWindow = captured.steps.filter((s) => s.index >= check.fromStepIndex);
  const excluded = inWindow.filter((s) => s.intendedLandsOn === undefined);
  const relevant = inWindow.filter(
    (s) => s.intendedLandsOn !== undefined && authSet.has(s.intendedLandsOn),
  );
  const excludedNote =
    excluded.length > 0
      ? [
          `${excluded.length} captured step(s) in the checked window lack intendedLandsOn (malformed capture) — cannot confirm they avoided authenticated content; capping at inconclusive`,
        ]
      : [];
  if (relevant.length === 0) {
    return {
      verdict: 'inconclusive',
      evidence: [
        ...excludedNote,
        `no executed step from index ${check.fromStepIndex} targeted an authenticated state — nothing to judge`,
      ],
    };
  }
  const evidence: string[] = [];
  let anyDeterminate = false;
  for (const step of relevant) {
    if (step.outcome !== 'ok') {
      evidence.push(`step ${step.index} did not execute — no auth signal`);
      continue;
    }
    // Re-rendering authenticated content after auth loss is the violation.
    if (step.predicates?.authenticated === true) {
      return {
        verdict: 'violation',
        evidence: [
          `step ${step.index} re-rendered authenticated content (predicate authenticated=true) after auth loss`,
        ],
      };
    }
    if (anyRedirect(step.network)) {
      anyDeterminate = true;
      evidence.push(`step ${step.index} redirected (3xx) instead of serving authenticated content`);
      continue;
    }
    if (step.predicates?.authenticated === false) {
      anyDeterminate = true;
      evidence.push(
        `step ${step.index} landed on a non-authenticated page (predicate authenticated=false)`,
      );
      continue;
    }
    // Landed somewhere other than the intended auth page ⇒ effectively redirected away.
    if (
      step.url !== undefined &&
      authTemplates.size > 0 &&
      ![...authTemplates].some((t) => matchesTemplate(step.url!, t))
    ) {
      anyDeterminate = true;
      evidence.push(
        `step ${step.index} did not land on the authenticated URL — treated as redirected away`,
      );
      continue;
    }
    evidence.push(`step ${step.index} produced no decisive auth signal`);
  }
  if (anyDeterminate && excluded.length === 0) {
    return { verdict: 'pass', evidence };
  }
  return {
    verdict: 'inconclusive',
    evidence: [
      ...excludedNote,
      ...(evidence.length ? evidence : ['no decisive auth signal captured']),
    ],
  };
}

function evalRejectOrRedirect(
  check: Extract<ContractCheck, { kind: 'expect-reject-or-redirect' }>,
  captured: CapturedTrace,
  refs: ContractRefs,
): ContractEvaluation {
  const entry = captured.entry;
  if (entry.outcome !== 'ok') {
    return {
      verdict: 'inconclusive',
      evidence: [
        `direct entry to ${check.target} did not execute cleanly — cannot judge rejection`,
      ],
    };
  }
  if (anyRedirect(entry.network)) {
    return {
      verdict: 'pass',
      evidence: [`direct entry to ${check.target} redirected (3xx) — prerequisite gate enforced`],
    };
  }
  const errorStatus = entry.network?.some(
    (e) => e.statusClass === '4xx' || e.statusClass === '5xx',
  );
  if (errorStatus) {
    return {
      verdict: 'pass',
      evidence: [
        `direct entry to ${check.target} rejected with a 4xx/5xx — prerequisite gate enforced`,
      ],
    };
  }
  const targetTemplate = refs.urlTemplates[check.target];
  if (targetTemplate && entry.url !== undefined && !matchesTemplate(entry.url, targetTemplate)) {
    return {
      verdict: 'pass',
      evidence: [
        `direct entry did not land on ${targetTemplate} — redirected away from the mid-flow state`,
      ],
    };
  }
  // Landed on the target with no rejection/redirect signal ⇒ the gate is missing.
  if (targetTemplate && entry.url !== undefined && matchesTemplate(entry.url, targetTemplate)) {
    return {
      verdict: 'violation',
      evidence: [
        `direct entry landed on ${targetTemplate} (skipping ${check.omittedPrerequisites.length} prerequisite step(s)) with no rejection or redirect`,
      ],
    };
  }
  return {
    verdict: 'inconclusive',
    evidence: [`no decisive rejection/redirect signal for direct entry to ${check.target}`],
  };
}

function evalSafeRevisit(
  check: Extract<ContractCheck, { kind: 'expect-safe-revisit' }>,
  captured: CapturedTrace,
): ContractEvaluation {
  // The revisit is the last step landing on the terminal target.
  const revisitSteps = captured.steps.filter((s) => s.intendedLandsOn === check.target);
  const revisit = revisitSteps[revisitSteps.length - 1];
  if (!revisit || revisit.outcome !== 'ok') {
    return {
      verdict: 'inconclusive',
      evidence: [`revisit of ${check.target} did not execute cleanly — cannot judge reprocessing`],
    };
  }
  const write = anyWrite(revisit.network);
  if (write) {
    return {
      verdict: 'violation',
      evidence: [
        `revisiting completed ${check.target} fired a side-effecting ${write.method} ${write.urlTemplate} — the flow re-processed`,
      ],
    };
  }
  return {
    verdict: 'pass',
    evidence: [
      `revisiting ${check.target} fired no side-effecting request — a redirect away or a safe re-show both pass`,
    ],
  };
}

/** Path-only URL-template match: `:param` segments match any single path segment. */
export function matchesTemplate(url: string, template: string): boolean {
  const pathOf = (u: string): string => {
    let p: string;
    try {
      p = new URL(u).pathname;
    } catch {
      p = new URL(u, 'http://localhost').pathname;
    }
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p === '' ? '/' : p;
  };
  const path = pathOf(url);
  const tmpl = template.startsWith('/') || template.startsWith('http') ? template : `/${template}`;
  const tmplPath = tmpl.startsWith('http') ? pathOf(tmpl) : tmpl.replace(/\/+$/, '') || '/';
  const us = path === '/' ? [] : path.split('/').filter(Boolean);
  const ts = tmplPath === '/' ? [] : tmplPath.split('/').filter(Boolean);
  if (us.length !== ts.length) return false;
  return ts.every((seg, i) => seg.startsWith(':') || seg === us[i]);
}

/**
 * Evaluate a variant's expected-outcome contract against the signals captured
 * from its run, returning pass / violation / inconclusive. Pure. Conservative
 * by construction: a correct app is never flagged, and any ambiguity resolves to
 * inconclusive.
 */
export function evaluateContract(
  contract: Contract,
  captured: CapturedTrace,
  refs: ContractRefs,
): ContractEvaluation {
  switch (contract.check.kind) {
    case 'no-repeated-write':
      return evalNoRepeatedWrite(contract.check, captured);
    case 'expect-auth-redirect':
      return evalAuthRedirect(contract.check, captured, refs);
    case 'expect-reject-or-redirect':
      return evalRejectOrRedirect(contract.check, captured, refs);
    case 'expect-safe-revisit':
      return evalSafeRevisit(contract.check, captured);
  }
}

// ---------------------------------------------------------------------------
// Evidence completeness — never pass on absent evidence
// ---------------------------------------------------------------------------

/**
 * The captured-step indices a contract's check NEEDS a record for, derived from
 * the compiled script (whose steps carry `intendedLandsOn`). The entry
 * navigation is index -1.
 */
export function contractRequiredStepIndices(contract: Contract, script: CompiledScript): number[] {
  const c = contract.check;
  switch (c.kind) {
    case 'no-repeated-write':
      return [c.injectedStepIndex];
    case 'expect-auth-redirect': {
      const authSet = new Set(c.authStates);
      return script.steps
        .filter(
          (s) =>
            s.index >= c.fromStepIndex &&
            s.intendedLandsOn !== undefined &&
            authSet.has(s.intendedLandsOn),
        )
        .map((s) => s.index);
    }
    case 'expect-reject-or-redirect':
      return [-1];
    case 'expect-safe-revisit': {
      // The revisit is the LAST script step landing on the terminal target
      // (mirrors evalSafeRevisit's selection).
      for (let i = script.steps.length - 1; i >= 0; i--) {
        if (script.steps[i].intendedLandsOn === c.target) return [script.steps[i].index];
      }
      return [];
    }
  }
}

/**
 * Required-step indices with no captured record at all. A fallback that returns
 * `grounded: true` with a PARTIAL capture must not let evaluators judge on the
 * truncated evidence — a missing record here forces inconclusive
 * ('incomplete-capture') before any contract logic runs.
 */
export function missingCaptureIndices(
  contract: Contract,
  script: CompiledScript,
  captured: CapturedTrace,
): number[] {
  return contractRequiredStepIndices(contract, script).filter(
    (i) => stepAt(captured, i) === undefined,
  );
}

/**
 * Completeness-guarded contract evaluation: verify every step the contract
 * references has a captured record BEFORE evaluating; anything missing makes
 * the check inconclusive with reason 'incomplete-capture'. Never pass on
 * absent evidence.
 */
export function evaluateContractComplete(
  script: CompiledScript,
  captured: CapturedTrace,
): ContractEvaluation {
  const missing = missingCaptureIndices(script.contract, script, captured);
  if (missing.length > 0) {
    return {
      verdict: 'inconclusive',
      evidence: [
        `incomplete-capture: no captured record for contract-referenced step(s) ${missing.join(', ')} — cannot evaluate on truncated evidence`,
      ],
    };
  }
  return evaluateContract(script.contract, captured, script.contractRefs);
}

// ---------------------------------------------------------------------------
// Signal completeness — which capture channels were present
// ---------------------------------------------------------------------------

/**
 * Which signal channels a captured run actually carried, over its executed
 * ('ok') steps. Missing channels silently push verdicts toward inconclusive
 * (which is directionally correct — conservative), but that downgrade must be
 * VISIBLE: a systematic capture gap (network hook absent, predicates never
 * sampled) shows up here in reporting instead of reading as eternal
 * inconclusive.
 */
export interface SignalCompleteness {
  /** At least one executed step carried a network signature list. */
  network: boolean;
  /** At least one executed step carried sampled page predicates. */
  predicates: boolean;
  /** At least one executed step carried a live URL. */
  url: boolean;
}

/** Compute {@link SignalCompleteness} over the entry + all executed steps. */
export function signalCompletenessOf(captured: CapturedTrace): SignalCompleteness {
  const executed = [captured.entry, ...captured.steps].filter((s) => s.outcome === 'ok');
  return {
    network: executed.some((s) => s.network !== undefined),
    predicates: executed.some((s) => s.predicates !== undefined),
    url: executed.some((s) => s.url !== undefined),
  };
}

// ---------------------------------------------------------------------------
// Per-variant execution
// ---------------------------------------------------------------------------

/** Whether a variant ran fully scripted or fell back to the agent tier. */
export type ExecutionTier = 'scripted' | 'agent-fallback';

/**
 * The result category, keeping the epic's cardinal split:
 *  - 'assertion'    = the trace grounded (scripted or via the agent) and the
 *                     contract was evaluated → a real flow-logic verdict.
 *  - 'grounding-gap' = the trace could not be grounded even by the agent →
 *                     spec/app drift, a maintenance signal, NEVER an app bug.
 */
export type VariantCategory = 'assertion' | 'grounding-gap';

export interface VariantResult {
  variantId: string;
  operator: MutationOperatorName;
  contractClass: ContractClass;
  provenance: CompiledScript['provenance'];
  tier: ExecutionTier;
  category: VariantCategory;
  /** Present iff `category === 'assertion'`: the three-outcome contract verdict. */
  verdict?: ContractVerdict;
  /** Present iff `category === 'grounding-gap'`: which step drifted, and why. */
  groundingGap?: { failedStepIndex: number; reason: string };
  /** Re-recorded recipe hint, when the agent re-grounded a drifted step. */
  reRecorded?: { stepIndex: number; note: string };
  /** Evidence lines backing the verdict / grounding-gap. */
  evidence: string[];
  /**
   * Which capture channels the evaluated run carried (present whenever a
   * contract was evaluated against a captured trace). Missing channels bias
   * verdicts toward inconclusive; this field makes that bias visible so
   * systematic capture gaps surface in reporting.
   */
  signalCompleteness?: SignalCompleteness;
  /** Mirrors the variant's tolerate-vs-reject expectation. */
  wellFormed: boolean;
}

/** Drive every compiled step, stopping at the first grounding failure. */
async function driveScripted(
  script: CompiledScript,
  driver: StepDriver,
): Promise<{ captured: CapturedTrace; failedStepIndex: number | null }> {
  const entry = await driver.runStep(script.entry);
  if (entry.outcome === 'grounding-failure') {
    return { captured: { entry, steps: [] }, failedStepIndex: -1 };
  }
  const steps: CapturedStep[] = [];
  for (const step of script.steps) {
    const cap = await driver.runStep(step);
    steps.push(cap);
    if (cap.outcome === 'grounding-failure') {
      return { captured: { entry, steps }, failedStepIndex: step.index };
    }
  }
  return { captured: { entry, steps }, failedStepIndex: null };
}

/**
 * Execute one compiled variant scripted-first, falling back to the agent once on
 * a grounding failure, then evaluate its contract. Never throws — driver /
 * fallback contract violations that DO throw are caught and reported as an
 * inconclusive assertion (a scripted run that could not produce signal), never
 * as an app bug.
 */
export async function executeVariant(
  script: CompiledScript,
  driver: StepDriver,
  fallback: AgentFallback,
): Promise<VariantResult> {
  const base = {
    variantId: script.variantId,
    operator: script.operator,
    contractClass: script.contractClass,
    provenance: script.provenance,
    wellFormed: script.wellFormed,
  };

  let scripted: { captured: CapturedTrace; failedStepIndex: number | null };
  try {
    scripted = await driveScripted(script, driver);
  } catch (err) {
    return {
      ...base,
      tier: 'scripted',
      category: 'assertion',
      verdict: 'inconclusive',
      evidence: [`scripted driver threw: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Fully grounded scripted run → evaluate the contract directly (still
  // completeness-guarded: a driver that drops a captured record must surface
  // as incomplete-capture, never as a pass on partial evidence).
  if (scripted.failedStepIndex === null) {
    const evaluation = evaluateContractComplete(script, scripted.captured);
    return {
      ...base,
      tier: 'scripted',
      category: 'assertion',
      verdict: evaluation.verdict,
      evidence: evaluation.evidence,
      signalCompleteness: signalCompletenessOf(scripted.captured),
    };
  }

  // Scripted grounding failure → agent-first fallback, once.
  const failedStepIndex = scripted.failedStepIndex;
  const driftReason =
    stepReason(scripted.captured, failedStepIndex) ?? `step ${failedStepIndex} failed to ground`;

  let outcome: AgentFallbackOutcome;
  try {
    outcome = await fallback.runTrace(script, failedStepIndex);
  } catch (err) {
    return {
      ...base,
      tier: 'agent-fallback',
      category: 'grounding-gap',
      groundingGap: {
        failedStepIndex,
        reason: `agent fallback threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      evidence: [
        `scripted drift: ${driftReason}`,
        'agent fallback errored — reported as a grounding gap, not an app bug',
      ],
    };
  }

  if (!outcome.grounded || !outcome.captured) {
    return {
      ...base,
      tier: 'agent-fallback',
      category: 'grounding-gap',
      groundingGap: { failedStepIndex, reason: outcome.reason ?? driftReason },
      evidence: [
        `scripted drift: ${driftReason}`,
        `agent could not ground the trace either: ${outcome.reason ?? 'unknown'} — grounding gap, feeds model/vocabulary maintenance, NOT an app bug`,
      ],
    };
  }

  // Agent re-grounded the trace → evaluate the contract against ITS signals.
  // The completeness guard matters most here: an agent that claims grounded but
  // returns a partial capture must not produce a pass on truncated evidence.
  const evaluation = evaluateContractComplete(script, outcome.captured);
  return {
    ...base,
    tier: 'agent-fallback',
    category: 'assertion',
    verdict: evaluation.verdict,
    reRecorded: outcome.reRecorded,
    signalCompleteness: signalCompletenessOf(outcome.captured),
    evidence: [
      `scripted step ${failedStepIndex} drifted (${driftReason}); agent re-grounded the trace`,
      ...(outcome.reRecorded
        ? [
            `recipe re-recorded for step ${outcome.reRecorded.stepIndex}: ${outcome.reRecorded.note}`,
          ]
        : []),
      ...evaluation.evidence,
    ],
  };
}

function stepReason(captured: CapturedTrace, index: number): string | undefined {
  const step = index < 0 ? captured.entry : captured.steps.find((s) => s.index === index);
  return step?.reason;
}

/** Execute a whole compiled suite in order. */
export async function executeCompiledSuite(
  scripts: CompiledScript[],
  driver: StepDriver,
  fallback: AgentFallback,
): Promise<VariantResult[]> {
  const out: VariantResult[] = [];
  for (const script of scripts) {
    out.push(await executeVariant(script, driver, fallback));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface SuiteExecutionSummary {
  total: number;
  /** Contract verdicts across assertion-category variants. */
  pass: number;
  violation: number;
  inconclusive: number;
  /** Variants that could not be grounded even by the agent (drift). */
  groundingGaps: number;
  /** Variants that fell back to the agent tier (grounded or not). */
  agentFallbacks: number;
}

/** Aggregate per-variant results into a suite-level summary. */
export function summarizeExecution(results: VariantResult[]): SuiteExecutionSummary {
  const summary: SuiteExecutionSummary = {
    total: results.length,
    pass: 0,
    violation: 0,
    inconclusive: 0,
    groundingGaps: 0,
    agentFallbacks: 0,
  };
  for (const r of results) {
    if (r.tier === 'agent-fallback') summary.agentFallbacks += 1;
    if (r.category === 'grounding-gap') {
      summary.groundingGaps += 1;
      continue;
    }
    if (r.verdict === 'pass') summary.pass += 1;
    else if (r.verdict === 'violation') summary.violation += 1;
    else summary.inconclusive += 1; // 'inconclusive' or an absent verdict
  }
  return summary;
}

/** One-line human summary of a suite run, for a CLI/report footer. */
export function renderExecutionSummary(results: VariantResult[]): string {
  const s = summarizeExecution(results);
  return (
    `Trace execution: ${s.total} variant${s.total === 1 ? '' : 's'} — ` +
    `${s.pass} pass, ${s.violation} violation, ${s.inconclusive} inconclusive, ` +
    `${s.groundingGaps} grounding-gap (${s.agentFallbacks} agent-fallback)`
  );
}
