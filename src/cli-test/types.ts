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
