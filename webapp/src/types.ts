export interface Target {
  type: 'web' | 'cli' | 'api';
  url?: string;
  binary?: string;
}

export interface Evidence {
  type: string;
  label: string;
  content: string;
}

export interface Behavior {
  id: string;
  description: string;
  details?: string;
  tags?: string[];
}

export interface Area {
  id: string;
  name: string;
  prose?: string;
  behaviors: Behavior[];
}

export interface Spec {
  version: string;
  name: string;
  description?: string;
  target: Target;
  areas: Area[];
}

export interface ActionTraceEntry {
  type: 'navigation' | 'click' | 'fill' | 'screenshot' | 'observation' | 'assertion' | 'wait' | 'other';
  description: string;
  screenshot?: string;
  timestamp?: string;
}

export interface BehaviorResult {
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  method?: string;
  evidence?: Evidence[];
  action_trace?: ActionTraceEntry[];
  rationale?: string;
  /**
   * Post-hoc confirmation added by the CLI after running the behavior's
   * generated Playwright test (SP-y2b). `confirmed: false` renders as
   * "unconfirmed" — it never means the behavior actually passed.
   */
  repro?: {
    test?: string;
    confirmed: boolean;
    output: string;
  };
}

/** One axis of the navigation-map coverage summary (states or transitions). */
export interface NavMapAxisCoverage {
  known: number;
  visited: number;
  ratio: number;
}

/**
 * Navigation-map coverage of a verify run, embedded by the runner under
 * `navMapCoverage` when SPECIFY_ENABLE_NAV_MAP_COVERAGE is on (see
 * src/model/runner-hooks.ts). Measures how much of the map learned from prior
 * runs this run exercised — `empty` when there was no prior model to compare
 * against (the first run of a target).
 */
export interface NavMapCoverage {
  summary: string;
  states: NavMapAxisCoverage;
  transitions: NavMapAxisCoverage;
  empty: boolean;
  predicateMismatch: boolean;
}

export interface VerifyResults {
  pass: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  results: BehaviorResult[];
  /** Present only when the navigation-map coverage flag was on for the run. */
  navMapCoverage?: NavMapCoverage;
}

export type StatusFilter = 'all' | 'passed' | 'failed' | 'skipped' | 'untested';

// ---------------------------------------------------------------------------
// Formula review (SP-7lv) — compiled LTLf formulas, rendered with witness
// examples so review is "read these example runs", not "read this AST".
// See src/monitor/witness.ts / src/spec/formulas.ts on the server side.
// ---------------------------------------------------------------------------

export type FormulaStatus = 'draft' | 'approved' | 'rejected';

/** One accepting or rejecting example trace, already rendered in plain English. */
export interface FormulaWitness {
  length: number;
  trace: string;
  narrative: string;
}

export interface FormulaWitnessSet {
  accepting: FormulaWitness[];
  rejecting: FormulaWitness[];
  /** True iff the formula can never be violated (a tautology) — a vacuity red flag. */
  vacuousRejecting: boolean;
  /** True iff the formula can never be satisfied (a contradiction). */
  vacuousAccepting: boolean;
  coverage: 'exhaustive-to-k' | 'sampled';
}

export interface FormulaProvenance {
  compiled_by: string;
  model?: string;
  session_id?: string;
  compiled_at: string;
}

/** A compiled formula entry joined with review context by GET /api/formulas. */
export interface FormulaReviewEntry {
  id: string;
  behavior: string;
  behaviorDescription: string | null;
  description_hash: string;
  prettyFormula: string;
  predicates_used: string[];
  status: FormulaStatus;
  provenance: FormulaProvenance;
  witnesses: FormulaWitnessSet;
  parent_of?: string[];
}
