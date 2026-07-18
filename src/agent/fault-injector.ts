/**
 * src/agent/fault-injector.ts — Seeded fault-scenario injection for the
 * capture route handler (src/agent/capture.ts).
 *
 * HONEST FRAMING: this is resilience REGRESSION testing over a fixed,
 * seeded fault schedule against a live target — it is NOT deterministic
 * simulation (the backend is real, timing still varies) and NOT
 * coverage-guided search. A FaultPlan is a fixed script describing which
 * requests get faulted; the seeded PRNG only decides whether a sub-1.0-rate
 * rule fires for a given request, not what's "wrong" with the target.
 * Keep naming and docs on that line — do not describe this as a simulator.
 *
 * Faults are decided and applied BEFORE the request reaches the network
 * (see CaptureCollector.attachToContext in capture.ts): a fault-matched
 * request never calls route.fetch(), so the live server sees no side
 * effects for that request.
 */

/** Fault vocabulary shared in spirit with mock-server.ts's MOCK_FAULT_TYPES
 * (302/500/timeout/empty/malformed, Math.random-based, server-side). This
 * injector is seeded and client-side (route-layer), so it reuses the type
 * names that make sense at the route-interception point rather than the
 * full server-side vocabulary (no '302' or 'malformed' here — those are
 * response-shape concerns for a real backend, not something a route
 * handler fabricates convincingly without a body to mutate). */
export type FaultType = '500' | 'timeout' | 'abort' | 'empty';

/** A single fault rule: which requests it matches, what it does to them,
 * and how often it fires. */
export interface FaultRule {
  /**
   * Pattern matched against the request URL. Supports a `*` wildcard
   * (translated to a permissive regex); without a `*`, it's a plain
   * substring match against the full URL.
   */
  urlPattern: string;
  /** Optional HTTP method filter (case-insensitive). Matches any method if omitted. */
  method?: string;
  fault: FaultType;
  /**
   * 0.0–1.0 probability this rule fires when matched. 1.0 (the common case
   * for verdict-bearing runs) is deterministic — every matching request is
   * faulted. Values below 1.0 are decided by a seeded PRNG keyed on
   * (seed, seq), so re-running the same plan against the same request
   * sequence reproduces identical decisions.
   */
  rate: number;
}

/** A fixed, seeded schedule of fault rules for one run. */
export interface FaultPlan {
  seed: number;
  rules: FaultRule[];
}

export interface FaultDecision {
  rule: FaultRule;
  fault: FaultType;
}

/**
 * mulberry32 — a small, fast, deterministic 32-bit PRNG. Not
 * cryptographically secure; that's not the goal here, reproducibility is.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure, stateless draw in [0, 1) for a given (seed, seq) pair. Combining
 * seed and seq into a single mulberry32 state means decide() doesn't need
 * to maintain PRNG call-order state across requests — the same (seed, seq)
 * always draws the same number, independent of what else has been decided.
 */
export function seededDraw(seed: number, seq: number): number {
  const combined = (seed ^ Math.imul(seq + 1, 0x9e3779b1)) >>> 0;
  return mulberry32(combined)();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Substring match, or a `*`-wildcard match if the pattern contains `*`. */
export function patternMatches(pattern: string, url: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return url.includes(pattern);
  const source = pattern.split('*').map((part) => escapeRegExp(part)).join('.*');
  // Pattern is operator-authored (CLI --fault flags or the agent's own
  // browser_inject_fault calls) — not attacker-controlled input — so the
  // dynamic RegExp construction here isn't a ReDoS/injection surface.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const regex = new RegExp(source);
  return regex.test(url);
}

/**
 * Holds the active FaultPlan (if any) for a capture session and decides
 * whether a given request should be faulted. Mutable via addRule/clear so
 * an agent can scope faults to a single behavior mid-run (see
 * browser_inject_fault / browser_clear_faults in browser-mcp.ts).
 */
export class FaultInjector {
  private plan: FaultPlan;

  constructor(plan?: FaultPlan) {
    this.plan = plan ?? { seed: 1, rules: [] };
  }

  getPlan(): FaultPlan {
    return this.plan;
  }

  setPlan(plan: FaultPlan): void {
    this.plan = plan;
  }

  /** Add a rule to the active plan (creating one with the default seed if none exists yet). */
  addRule(rule: FaultRule): void {
    this.plan.rules.push(rule);
  }

  /** Remove all rules. The plan's seed is left in place; only rules are cleared. */
  clear(): void {
    this.plan = { ...this.plan, rules: [] };
  }

  /** Whether any rule is currently active. */
  isActive(): boolean {
    return this.plan.rules.length > 0;
  }

  /**
   * Decide whether request `seq` (a monotonically increasing per-session
   * counter, not a retry count) should be faulted. Returns the first
   * matching rule's decision, or null if no rule matches or fires.
   */
  decide(url: string, method: string, seq: number): FaultDecision | null {
    for (const rule of this.plan.rules) {
      if (!patternMatches(rule.urlPattern, url)) continue;
      if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) continue;

      if (rule.rate >= 1) {
        return { rule, fault: rule.fault };
      }
      if (rule.rate <= 0) continue;
      if (seededDraw(this.plan.seed, seq) < rule.rate) {
        return { rule, fault: rule.fault };
      }
    }
    return null;
  }
}

/** Parse a `<urlPattern>=<type>` CLI arg (as used by `--fault`) into a deterministic (rate 1.0) FaultRule. */
export function parseFaultArg(arg: string): FaultRule | null {
  const eq = arg.lastIndexOf('=');
  if (eq === -1) return null;
  const urlPattern = arg.slice(0, eq);
  const fault = arg.slice(eq + 1);
  if (!urlPattern || !isFaultType(fault)) return null;
  return { urlPattern, fault, rate: 1.0 };
}

export function isFaultType(value: string): value is FaultType {
  return value === '500' || value === 'timeout' || value === 'abort' || value === 'empty';
}
