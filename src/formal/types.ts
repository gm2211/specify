import type { FormalCheck, LeanFormalCheck, QuintFormalCheck } from '../spec/types.js';

export type FormalStatus = 'passed' | 'failed' | 'error' | 'timeout' | 'unavailable';
export type FormalEvidence = 'simulation' | 'bounded-model-check' | 'proof';

export interface FormalScope {
  mode: 'simulate' | 'verify';
  backend: 'typescript' | 'apalache';
  maxSteps: number;
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

export interface FormalCheckResult {
  behaviorId: string;
  check: FormalCheck;
  outcome: FormalOutcome;
}

export interface FormalCheckSummary {
  valid: boolean;
  scope: 'formal-models-only';
  results: FormalCheckResult[];
  unlinkedBehaviorIds: string[];
}

export type { FormalCheck, LeanFormalCheck, QuintFormalCheck };
