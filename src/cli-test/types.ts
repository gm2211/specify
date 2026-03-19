/**
 * src/cli-test/types.ts — CLI validation capture and report types
 */

import type { CheckStatus } from '../validation/types.js';

// ---------------------------------------------------------------------------
// Capture data (output of running commands)
// ---------------------------------------------------------------------------

/** Result of executing a single CLI command. */
export interface CliCommandRun {
  /** Command spec id. */
  id: string;
  /** Arguments passed. */
  args: string[];
  /** Process exit code. */
  exitCode: number;
  /** Full stdout output. */
  stdout: string;
  /** Full stderr output. */
  stderr: string;
  /** Execution time in milliseconds. */
  durationMs: number;
  /** ISO timestamp when the command started. */
  timestamp: string;
  /** Whether the command timed out. */
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// CLI validation report
// ---------------------------------------------------------------------------

/** Full CLI validation report. */
export interface CliGapReport {
  spec: {
    name: string;
    version: string;
    description?: string;
  };
  cli: {
    binary: string;
    timestamp: string;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    untested: number;
    coverage: number;
  };
  commands: CliCommandResult[];
  scenarios: CliScenarioResult[];
  /** Behavioral requirements from the spec, with verification status. */
  requirements?: RequirementResult[];
  /** Normative claims grounded by commands, scenarios, and/or requirements. */
  claims?: ClaimResult[];
}

/** Result for a behavioral requirement. */
export interface RequirementResult {
  /** Requirement ID from the spec. */
  id: string;
  /** Requirement description. */
  description: string;
  /** Verification type: mechanical or agent. */
  verification: string;
  /** Current status: "verified", "unverified", or "failed". */
  status: 'verified' | 'unverified' | 'failed';
  /** Evidence provided by an agent (empty until an agent validates it). */
  evidence?: unknown;
  /** Results from inline property checks (when requirement has checks). */
  check_results?: CliCommandResult[];
}

/** Result for a normative claim grounded by executable checks and/or requirements. */
export interface ClaimResult {
  /** Claim ID from the spec. */
  id: string;
  /** Claim description. */
  description: string;
  /** How the claim was grounded. */
  groundedBy: {
    commands: RefStatus[];
    scenarios: RefStatus[];
    requirements: RefStatus[];
  };
  /** Current status. */
  status: 'passed' | 'failed';
  /** Reason for failure, when available. */
  reason?: string;
}

/** Status of an individual grounding reference. */
export interface RefStatus {
  id: string;
  status: 'passed' | 'failed' | 'missing';
  reason?: string;
}

/** Result of validating one CLI command. */
export interface CliCommandResult {
  commandId: string;
  description?: string;
  args: string[];
  status: CheckStatus;
  exitCode: CliExitCodeResult;
  stdoutAssertions: CliAssertionResult[];
  stderrAssertions: CliAssertionResult[];
  durationMs: number;
  timedOut: boolean;
  /** Truncated stdout for inline evidence in reports. */
  stdoutPreview?: string;
  /** Truncated stderr for inline evidence in reports. */
  stderrPreview?: string;
}

/** Result of checking the exit code. */
export interface CliExitCodeResult {
  expected: number | number[];
  actual: number;
  status: CheckStatus;
}

/** Result of a single output assertion. */
export interface CliAssertionResult {
  type: string;
  description?: string;
  status: CheckStatus;
  reason?: string;
  /** The actual value for json_path assertions. */
  actual?: unknown;
  /** The expected value. */
  expected?: unknown;
}

/** Result for a CLI scenario. */
export interface CliScenarioResult {
  scenarioId: string;
  description?: string;
  status: CheckStatus;
  steps: CliCommandResult[];
}
