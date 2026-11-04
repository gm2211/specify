/** What a linked check must observe. `fails` marks a "before" model or mutation that must break. */
export type Expectation = 'holds' | 'fails';
export type QuintKind = 'invariant' | 'temporal';

export interface QuintFormalCheck {
  tool: 'quint';
  /** Relative to the project root (the directory that contains `openspec/`). */
  file: string;
  property: string;
  kind: QuintKind;
  /** `verify` explores states with a model checker; `simulate` samples random traces. */
  mode: 'verify' | 'simulate';
  /** TLC explores every reachable state; Apalache is bounded by maxSteps; simulation uses Quint's own runner. */
  backend: 'tlc' | 'apalache' | 'typescript';
  expect: Expectation;
  main?: string;
  /** Apalache and simulation only. */
  maxSteps?: number;
  /** Simulation only; both required for reproducible sampling. */
  samples?: number;
  seed?: number;
}

export interface LeanFormalCheck {
  tool: 'lean';
  /** Relative to the project root. */
  file: string;
  /** Public, fully qualified theorem name. */
  property: string;
  expect: 'holds';
}

export type FormalCheck = QuintFormalCheck | LeanFormalCheck;

/** `holds`: no violation / proof accepted. `fails`: counterexample or rejected proof. */
export type FormalStatus = 'holds' | 'fails' | 'error' | 'timeout' | 'unavailable';
export type FormalEvidence =
  | 'simulation'
  | 'bounded-model-check'
  | 'exhaustive-model-check'
  | 'proof';

export interface FormalScope {
  mode: 'simulate' | 'verify';
  backend: 'tlc' | 'apalache' | 'typescript';
  kind: QuintKind;
  maxSteps?: number;
  samples?: number;
  seed?: number;
}

export interface FormalOutcome {
  status: FormalStatus;
  evidence: FormalEvidence;
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
  message?: string;
  axioms?: string[];
  statement?: string;
  scope?: FormalScope;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  unavailable: boolean;
  outputLimit: boolean;
  durationMs: number;
  message?: string;
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Where a `Formal:` line was written. */
export interface FormalSource {
  /** Spec file relative to the project root. */
  file: string;
  line: number;
  text: string;
}

export interface FormalCheckResult {
  /** `<capability>/<requirement name>`, e.g. `snooze/Resumed worker works again`. */
  requirementId: string;
  source: FormalSource;
  /** Absent when the `Formal:` line could not be parsed. */
  check?: FormalCheck;
  outcome: FormalOutcome;
  /** True only when the observed status equals the expectation. */
  ok: boolean;
}

export interface FormalCheckSummary {
  valid: boolean;
  scope: 'formal-models-only';
  root: string;
  results: FormalCheckResult[];
  /** Requirements with no `Formal:` line; listed so missing coverage stays visible. */
  unlinkedRequirementIds: string[];
  totals: { checks: number; ok: number; notOk: number };
}
