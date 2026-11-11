/** Exit codes for setup and formal checks. */
export const ExitCode = {
  SUCCESS: 0,
  CHECKS_NOT_AS_EXPECTED: 1,
  SETUP_FAILED: 2,
  /** `gate --hook stop`: Claude Code treats exit code 2 as "keep working". */
  HOOK_BLOCKED: 2,
  PARSE_ERROR: 10,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
