export interface Target {
  type: 'web' | 'cli' | 'api';
  url?: string;
  binary?: string;
}

export interface Evidence {
  type: string;
  label: string;
  content: string;
}

export interface Behavior {
  id: string;
  description: string;
  details?: string;
  tags?: string[];
}

export interface Area {
  id: string;
  name: string;
  prose?: string;
  behaviors: Behavior[];
}

export interface Spec {
  version: string;
  name: string;
  description?: string;
  target: Target;
  areas: Area[];
}

export interface ActionTraceEntry {
  type: 'navigation' | 'click' | 'fill' | 'screenshot' | 'observation' | 'assertion' | 'wait' | 'other';
  description: string;
  screenshot?: string;
  timestamp?: string;
}

export interface BehaviorResult {
  id: string;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  method?: string;
  evidence?: Evidence[];
  action_trace?: ActionTraceEntry[];
  rationale?: string;
  /**
   * Post-hoc confirmation added by the CLI after running the behavior's
   * generated Playwright test (SP-y2b). `confirmed: false` renders as
   * "unconfirmed" — it never means the behavior actually passed.
   */
  repro?: {
    test?: string;
    confirmed: boolean;
    output: string;
  };
}

export interface VerifyResults {
  pass: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  results: BehaviorResult[];
}

export type StatusFilter = 'all' | 'passed' | 'failed' | 'skipped' | 'untested';
