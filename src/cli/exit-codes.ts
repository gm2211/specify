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
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
