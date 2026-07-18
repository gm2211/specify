/**
 * Feature gates for speculative agent surfaces.
 *
 * Defaults should keep the public API small. Opt-in flags make experimental
 * loops available without advertising them in every run.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw ? TRUE_VALUES.has(raw.trim().toLowerCase()) : false;
}

export function learnedSkillsEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_LEARNED_SKILLS');
}

/**
 * Gate for the monitor-verdict merge (src/monitor/verdict-merge.ts): when
 * off, `specify.formulas.yaml` is never loaded and verify runs are
 * byte-identical to a build with no monitor tier at all. When on, verify
 * loads compiled formulas next to the spec and merges deterministic
 * verdicts into the agent's structured output per the asymmetric
 * reconciliation policy (approved-violated forces a fail; draft formulas
 * are shadow-mode advisory only).
 */
export function monitorVerdictsEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_MONITOR_VERDICTS');
}

/**
 * Seeded fault-scenario injection (src/agent/fault-injector.ts) is
 * off by default: it's a resilience-regression tool, not something every
 * verify run should carry. Opt in with SPECIFY_ENABLE_FAULT_INJECTION.
 */
export function faultInjectionEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_FAULT_INJECTION');
}
