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
 * Gate for the formula review UX (src/review/server.ts's /api/formulas
 * endpoints, webapp/src/components/FormulaPanel.tsx): when off, the review
 * server never lists, approves, or rejects compiled formulas. Deliberately
 * separate from `monitorVerdictsEnabled` — you can review and approve
 * formulas well before turning on verdict-gating in verify runs (or run
 * review indefinitely without ever gating), so the two lifecycles get
 * independent flags rather than one flag doing double duty.
 */
export function formulaReviewEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_FORMULA_REVIEW');
}

/**
 * Seeded fault-scenario injection (src/agent/fault-injector.ts) is
 * off by default: it's a resilience-regression tool, not something every
 * verify run should carry. Opt in with SPECIFY_ENABLE_FAULT_INJECTION.
 */
export function faultInjectionEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_FAULT_INJECTION');
}

/**
 * Gate for auto-demotion (src/monitor/formula-stats.ts's
 * applyRecompileDemotions): when off (default), an approved formula that
 * disagrees with the LLM's independent verdict is only FLAGGED for
 * recompilation — it keeps gating verdicts until a human acts. When on, the
 * flag is also acted on automatically: the formula demotes back to 'draft'
 * (shadow mode) the next time formulas are loaded for a run, so a drifted
 * formula stops silently forcing failures while awaiting recompilation.
 * Deliberately separate and off-by-default from monitorVerdictsEnabled —
 * telemetry (flagging) is safe to always run; automatically rewriting the
 * reviewed formulas file is a stronger policy decision.
 */
export function monitorAutoDemoteEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_MONITOR_AUTO_DEMOTE');
}
