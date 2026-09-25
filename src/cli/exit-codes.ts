/** Stable exit codes for contract and evidence consumers. */
export const ExitCode = {
  SUCCESS: 0,
  ASSERTION_FAILURE: 1,
  ALL_UNTESTED: 2,
  PARSE_ERROR: 10,
  TIMEOUT: 12,
  RUNNER_ERROR: 14,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
