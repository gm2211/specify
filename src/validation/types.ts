/**
 * src/validation/types.ts — Gap analysis report types
 *
 * These types describe the output of validating a spec against a capture session.
 * Each requirement in the spec maps to a result with status: passed | failed | untested.
 */

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Outcome of checking a single requirement against capture data. */
export type CheckStatus = 'passed' | 'failed' | 'untested';

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/** Full gap analysis report produced by the validator. */
export interface GapReport {
  spec: {
    name: string;
    version: string;
    description?: string;
  };
  capture: {
    /** Absolute path to the capture directory. */
    directory: string;
    /** ISO 8601 timestamp from the capture session. */
    timestamp: string;
    /** Base URL that was captured. */
    targetUrl: string;
    /** Total number of requests in the capture. */
    totalRequests: number;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    untested: number;
    /** Coverage percentage: (passed + failed) / total * 100 */
    coverage: number;
  };
  pages: PageResult[];
  flows: FlowResult[];

  /** Results of checking spec-level assumptions (preconditions). */
  assumptions?: AssumptionResult[];

  /** Results of checking universal default properties. */
  defaults?: DefaultResult[];
}

// ---------------------------------------------------------------------------
// Page-level results
// ---------------------------------------------------------------------------

/** Results for a single page spec. */
export interface PageResult {
  /** Matches PageSpec.id */
  pageId: string;
  /** URL path from the spec */
  path: string;
  /** Whether the page was visited in the capture */
  visited: boolean;
  requests: RequestResult[];
  visualAssertions: AssertionResult[];
  consoleExpectations: ConsoleResult[];
  scenarios: ScenarioResult[];
}

/** Result of checking one expected request. */
export interface RequestResult {
  /** HTTP method from the spec */
  method: string;
  /** URL pattern from the spec */
  urlPattern: string;
  description?: string;
  status: CheckStatus;
  /** The matching captured traffic entry URL, if found */
  matchedUrl?: string;
  /** Actual status code returned */
  actualStatus?: number;
  /** Expected status code from spec */
  expectedStatus?: number;
  /** Whether the response body matched the schema */
  bodySchemaValid?: boolean;
  /** Schema validation errors, if any */
  bodySchemaErrors?: string[];
  /** Reason for failure or untested */
  reason?: string;

  /** Whether this assertion must hold always or only sometimes. */
  quantifier?: 'always' | 'sometimes';
  /** How this assertion was established. */
  confidence?: 'observed' | 'inferred' | 'reviewed';
  /** Number of validation runs checked (multi-run support). */
  runsChecked?: number;
  /** Number of runs where this assertion passed (multi-run support). */
  runsPassed?: number;
  /** Classification of the finding across runs. */
  finding_type?: 'new' | 'resolved' | 'ongoing' | 'rare';
}

/** Result of checking a visual assertion. */
export interface AssertionResult {
  type: string;
  selector?: string;
  description?: string;
  status: CheckStatus;
  /** Reason for failure or untested */
  reason?: string;

  /** Whether this assertion must hold always or only sometimes. */
  quantifier?: 'always' | 'sometimes';
  /** How this assertion was established. */
  confidence?: 'observed' | 'inferred' | 'reviewed';
  /** Number of validation runs checked (multi-run support). */
  runsChecked?: number;
  /** Number of runs where this assertion passed (multi-run support). */
  runsPassed?: number;
  /** Classification of the finding across runs. */
  finding_type?: 'new' | 'resolved' | 'ongoing' | 'rare';
}

/** Result of checking a console expectation. */
export interface ConsoleResult {
  level: string;
  expectedCount?: number;
  actualCount?: number;
  excludePattern?: string;
  status: CheckStatus;
  /** Matching log entries that triggered a failure */
  matchingEntries?: string[];
  reason?: string;

  /** Whether this expectation must hold always or only sometimes. */
  quantifier?: 'always' | 'sometimes';
  /** How this expectation was established. */
  confidence?: 'observed' | 'inferred' | 'reviewed';
  /** Number of validation runs checked (multi-run support). */
  runsChecked?: number;
  /** Number of runs where this expectation passed (multi-run support). */
  runsPassed?: number;
  /** Classification of the finding across runs. */
  finding_type?: 'new' | 'resolved' | 'ongoing' | 'rare';
}

// ---------------------------------------------------------------------------
// Scenario-level results
// ---------------------------------------------------------------------------

/** Results for one scenario in a page. */
export interface ScenarioResult {
  scenarioId: string;
  description?: string;
  status: CheckStatus;
  steps: StepResult[];
}

/** Result for a single scenario step. */
export interface StepResult {
  action: string;
  description?: string;
  status: CheckStatus;
  /** Evidence found in the capture */
  evidence?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Flow-level results
// ---------------------------------------------------------------------------

/** Results for one multi-page flow. */
export interface FlowResult {
  flowId: string;
  description?: string;
  status: CheckStatus;
  steps: FlowStepResult[];
}

/** Result for a single step in a flow. */
export interface FlowStepResult {
  /** Step type: navigate | assert_page | action */
  type: string;
  description?: string;
  /** For navigate steps */
  path?: string;
  /** For assert_page steps */
  pageId?: string;
  status: CheckStatus;
  evidence?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Assumption and default results
// ---------------------------------------------------------------------------

/** Result of checking a single spec assumption (precondition). */
export interface AssumptionResult {
  /** The assumption type (e.g. "url_reachable", "env_var_set"). */
  type: string;
  /** Human-readable description of the assumption. */
  description?: string;
  /** Whether the assumption was satisfied. */
  status: CheckStatus;
  /** Reason for failure, if applicable. */
  reason?: string;
}

/** Result of checking a universal default property. */
export interface DefaultResult {
  /** The default property name (e.g. "no_5xx", "no_console_errors"). */
  property: string;
  /** Whether the property held. */
  status: CheckStatus;
  /** Additional details about the check. */
  details?: string;
  /** Reason for failure, if applicable. */
  reason?: string;
}
