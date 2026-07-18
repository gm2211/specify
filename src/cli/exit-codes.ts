/** Granular exit codes for agent-friendly consumption. */
export const ExitCode = {
  SUCCESS: 0,
  ASSERTION_FAILURE: 1,
  ALL_UNTESTED: 2,
  PARSE_ERROR: 10,
  NETWORK_ERROR: 11,
  TIMEOUT: 12,
  ASSUMPTION_FAILURE: 13,
  BROWSER_ERROR: 14,
  /**
   * Every failed behavior in the run was failed SOLELY by the monitor tier
   * (an approved LTLf formula's 'violated' verdict overturned an LLM
   * 'passed'/'skipped' status — see src/monitor/verdict-merge.ts's
   * asymmetric reconciliation policy). Ordinary failures — the LLM itself
   * reported 'failed' for at least one behavior, whether or not the monitor
   * agrees — keep ASSERTION_FAILURE. This lets CI distinguish "the agent
   * missed something the deterministic monitor caught" from "the agent
   * itself found a break".
   */
  MONITOR_VIOLATION: 15,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
