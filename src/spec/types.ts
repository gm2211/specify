/**
 * src/spec/types.ts — Spec format types (v2 behavioral)
 *
 * V2 specs describe WHAT should be true about a system, not HOW to verify it.
 * The agent figures out verification. Behaviors are plain-language claims
 * grouped into areas. No matchers, no selectors, no step sequences.
 */

// ---------------------------------------------------------------------------
// Target (what kind of system)
// ---------------------------------------------------------------------------

export interface WebTarget {
  type: 'web';
  url: string;
}

export interface CliTarget {
  type: 'cli';
  binary: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface ApiTarget {
  type: 'api';
  url: string;
  headers?: Record<string, string>;
}

export type Target = WebTarget | CliTarget | ApiTarget;

// ---------------------------------------------------------------------------
// Assumptions (simplified: plain language + optional check hint)
// ---------------------------------------------------------------------------

export interface Assumption {
  description: string;
  check?: string;
}

// ---------------------------------------------------------------------------
// Hooks (simplified: just a run string)
// ---------------------------------------------------------------------------

export interface HookStep {
  name: string;
  run: string;
  save_as?: string;
}

export interface Hooks {
  setup?: HookStep[];
  teardown?: HookStep[];
}

// ---------------------------------------------------------------------------
// Areas and behaviors (the core)
// ---------------------------------------------------------------------------

export interface Area {
  /** Kebab-case identifier. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** Essay-style narrative prose for this area. */
  prose?: string;

  /** Behavioral claims within this area. */
  behaviors: Behavior[];
}

export interface Behavior {
  /** Kebab-case identifier, unique within area. Fully-qualified: area-id/behavior-id. */
  id: string;

  /** The behavioral claim — what should be true. */
  description: string;

  /** Additional context, edge cases, or clarifications. */
  details?: string;

  /** Tags for filtering (e.g. ["auth", "ui"]). */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Top-level spec
// ---------------------------------------------------------------------------

export interface Spec {
  version: '2';
  name: string;
  description?: string;
  target: Target;
  variables?: Record<string, string>;
  assumptions?: Assumption[];
  hooks?: Hooks;
  areas: Area[];
  /** Path to companion narrative document (relative to spec file). */
  narrative_path?: string;
  /** Hint: where to look for existing tests (e.g. "tests/", "src/__tests__/"). */
  test_dir?: string;
}

// ---------------------------------------------------------------------------
// Verification report
// ---------------------------------------------------------------------------

export interface VerificationReport {
  spec: { name: string; version: string };
  timestamp: string;
  pass: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  results: BehaviorResult[];
}

export interface BehaviorResult {
  /** Fully-qualified: "area-id/behavior-id". */
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  /** How the agent verified this behavior. */
  method?: string;
  evidence?: Evidence[];
  /**
   * Ordered, human-readable log of what the agent did to verify this behavior.
   * Each entry describes one step (navigate, click, observe, assert, …) and may
   * reference a screenshot file captured at that moment.
   */
  action_trace?: ActionTraceEntry[];
  rationale?: string;
  duration_ms?: number;
  /**
   * Deterministic confirmation, added POST-HOC by the CLI after the agent
   * finishes — NEVER produced by the agent itself (it is not part of the
   * SDK output schema). For a "failed" behavior, the CLI runs the matching
   * generated Playwright test and records whether it independently
   * reproduces the failure.
   *
   * `confirmed: false` means "unconfirmed" — it must never be read as, or
   * used to flip, a passing status. The generated test itself can be wrong
   * (bad selector, missing setup), so this is metadata, not a verdict
   * override.
   */
  repro?: {
    /** Title of the matched generated test, if any (absent when no matching test was found). */
    test?: string;
    confirmed: boolean;
    /** Human-readable summary of the confirmation run. */
    output: string;
  };
  /**
   * Deterministic monitor verdicts, added POST-HOC by the runner after the
   * agent finishes — NEVER produced by the agent itself (deliberately not
   * part of the SDK output schema, same pattern as `repro`). One entry per
   * compiled LTLf formula attached to this behavior; see
   * src/monitor/verdict-merge.ts for the asymmetric reconciliation policy.
   */
  monitor?: MonitorVerdict[];
  /**
   * Who decided this behavior's final status. Absent when no formulas
   * applied. 'monitor' = an approved formula's violation overrode the LLM;
   * 'monitor+llm' = an approved formula's satisfied verdict corroborated the
   * LLM's pass; 'llm' = formulas were evaluated but the LLM's verdict stands
   * (shadow-mode drafts, inconclusive/unevaluable verdicts, or a monitor
   * satisfied that cannot overturn an LLM fail).
   */
  verdict_source?: 'monitor' | 'llm' | 'monitor+llm';
}

/**
 * One formula's verdict over the recorded run trace, attached post-hoc to a
 * BehaviorResult by the monitor merge (src/monitor/verdict-merge.ts).
 */
export interface MonitorVerdict {
  formula_id: string;
  /** Formula status at evaluation time. Draft formulas run in shadow mode: advisory only, never affect status. */
  status: 'draft' | 'approved';
  verdict: 'satisfied' | 'violated' | 'inconclusive' | 'unevaluable';
  /** Decisive trace position, when the evaluator pinned one down. */
  witness_step?: number;
  /** Human-readable rendering of the decisive position. */
  witness_detail?: string;
  /** Number of positions in the evaluated trace. */
  trace_length: number;
  /**
   * Set when the monitor and the LLM disagree in the direction the monitor
   * is NOT trusted to resolve (formula satisfied but LLM failed the
   * behavior). A formula checks only what was compiled, not the whole
   * claim, so 'satisfied' never overturns an LLM fail — the disagreement is
   * flagged here for burn-in review instead.
   */
  disagreement?: boolean;
}

export interface Evidence {
  type: 'screenshot' | 'text' | 'network_log' | 'command_output' | 'file';
  label: string;
  content: string;
}

export interface ActionTraceEntry {
  /**
   * What kind of step this is. The agent picks the closest match.
   */
  type: 'navigation' | 'click' | 'fill' | 'screenshot' | 'observation' | 'assertion' | 'wait' | 'other';
  /**
   * One-sentence description of the step in the agent's own words, e.g.
   * "Clicked the Start button" or "Observed countdown at 37 seconds".
   */
  description: string;
  /**
   * Path to a screenshot captured during this step, if any. Absolute paths
   * are accepted; the server serves them by basename under
   * `/api/screenshot/:name`.
   */
  screenshot?: string;
  /** ISO timestamp, optional. */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Gap analysis report
// ---------------------------------------------------------------------------

export interface GapAnalysisReport {
  spec: { name: string; version: string };
  timestamp: string;
  summary: {
    total_behaviors: number;
    covered: number;
    uncovered: number;
    coverage_pct: number;
    unmapped_tests: number;
  };
  behaviors: BehaviorCoverage[];
  unmapped_tests: UnmappedTest[];
}

export interface BehaviorCoverage {
  id: string;
  description: string;
  covered: boolean;
  matched_tests: MatchedTest[];
  suggested_test?: string;
}

export interface MatchedTest {
  file: string;
  test: string;
  rationale: string;
}

export interface UnmappedTest {
  file: string;
  test_name: string;
  framework?: string;
}
