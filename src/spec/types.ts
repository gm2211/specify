/**
 * src/spec/types.ts — Spec format types (v2 behavioral)
 *
 * V2 specs describe WHAT should be true about a system, not HOW to verify it.
 * External tools own verification. Behaviors are plain-language claims
 * grouped into areas. No matchers, no selectors, no step sequences.
 */

// ---------------------------------------------------------------------------
// Target (what kind of system)
// ---------------------------------------------------------------------------

export interface WebTarget {
  type: 'web';
  url: string;
}

export interface CliTarget {
  type: 'cli';
  binary: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

/** Legacy probe/production fields are metadata only; Specify never mutates a target. */
export interface ApiTarget {
  type: 'api';
  url: string;
  headers?: Record<string, string>;
  /** Legacy runner probe configuration; not executed. */
  probes?: {
    /** Opt-in switch. Probes never run against a target where this is falsy. */
    enabled?: boolean;
  };
  /** Legacy target classification; no probing occurs. */
  production?: boolean;
}

export type Target = WebTarget | CliTarget | ApiTarget;

// ---------------------------------------------------------------------------
// Assumptions (simplified: plain language + optional check hint)
// ---------------------------------------------------------------------------

export interface Assumption {
  description: string;
  check?: string;
}

// ---------------------------------------------------------------------------
// Hooks (simplified: just a run string)
// ---------------------------------------------------------------------------

export interface HookStep {
  name: string;
  run: string;
  save_as?: string;
}

export interface Hooks {
  setup?: HookStep[];
  teardown?: HookStep[];
}

// ---------------------------------------------------------------------------
// Areas and behaviors (the core)
// ---------------------------------------------------------------------------

export interface Area {
  /** Kebab-case identifier. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** Essay-style narrative prose for this area. */
  prose?: string;

  /** Behavioral claims within this area. */
  behaviors: Behavior[];
}

export interface Behavior {
  /** Kebab-case identifier, unique within area. Fully-qualified: area-id/behavior-id. */
  id: string;

  /** The behavioral claim — what should be true. */
  description: string;

  /** Additional context, edge cases, or clarifications. */
  details?: string;

  /** Tags for filtering (e.g. ["auth", "ui"]). */
  tags?: string[];

  /** Exact source wording for this requirement, when recorded. */
  source?: BehaviorSource;
}

export interface BehaviorSource {
  /** Preserve user's wording exactly; do not paraphrase or normalize it. */
  text: string;
  /** Optional source location or conversation reference. */
  reference?: string;
}

// ---------------------------------------------------------------------------
// Top-level spec
// ---------------------------------------------------------------------------

export interface Spec {
  version: '2';
  name: string;
  description?: string;
  target: Target;
  variables?: Record<string, string>;
  assumptions?: Assumption[];
  hooks?: Hooks;
  areas: Area[];
  /** Path to companion narrative document (relative to spec file). */
  narrative_path?: string;
  /** Hint: where to look for existing tests (e.g. "tests/", "src/__tests__/"). */
  test_dir?: string;
}
