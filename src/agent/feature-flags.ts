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

/**
 * Gate for navigation-map coverage wiring (src/model/runner-hooks.ts): when
 * off (default), the runner never loads or writes a per-target NavModel, verify
 * results carry no `navMapCoverage` field, and the capture/verify prompts get
 * no exploration hints — a run is byte-identical to a build with no navigation
 * map at all. When on, each run folds its observation trace into the persisted
 * per-target model (.specify/model/<spec_id>/<target_key>.json), embeds a
 * coverage summary (this run vs the map learned so far) in verify-result.json,
 * and injects coverage-directed exploration hints into the live prompts.
 */
export function navMapCoverageEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_NAV_MAP_COVERAGE');
}

/**
 * Opt-in TLA-family (Quint) spec integration for hand-modeled critical flows
 * (SP-i35): when off (default), the CLI never drafts, stores, simulates, or
 * bridges a Quint spec — a run is byte-identical to a build with no Quint tier
 * at all. When on, the drafting orchestrator and the ITF-to-trace bridge become
 * available for the 2-3 flows whose business logic outlives UI redesigns
 * (auth, checkout). Kept opt-in because dual-artifact maintenance (a
 * hand-written formal model ALONGSIDE the inferred navigation map) is exactly
 * what killed classic model-based-testing adoption — most teams should never
 * turn this on, and the inferred-model adversarial suite (SP-3fh/SP-w5d) is the
 * default path.
 */
export function quintSpecsEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_QUINT_SPECS');
}

/**
 * Gate for the JVM-backed symbolic checker (Apalache) behind the Quint
 * integration: OFF by default and deliberately separate from
 * quintSpecsEnabled. The default trace generator is `quint run` random
 * simulation, which is pure npm and needs no JVM. The symbolic backend
 * requires a Java runtime and a much heavier install, so it is a second,
 * stronger opt-in a team turns on only after the npm-only path is proven — the
 * runner refuses a symbolic request unless BOTH this flag and quintSpecsEnabled
 * are set.
 */
export function quintSymbolicBackendEnabled(): boolean {
  return envFlag('SPECIFY_ENABLE_QUINT_SYMBOLIC');
}
