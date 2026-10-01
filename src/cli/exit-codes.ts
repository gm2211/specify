/** Exit codes for spec authoring and review checks. */
export const ExitCode = {
  SUCCESS: 0,
  REVIEW_REQUIRED: 1,
  PARSE_ERROR: 10,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
