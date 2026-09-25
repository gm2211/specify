/** On-disk observation formats consumed by the report reader. */

export const SCRIPTED_METHOD = 'scripted-replay';

export type AxObservation =
  | { file: string; digest: string }
  | { unchanged: true; digest: string }
  | { error: string };

export interface StepObservation {
  step: number;
  action: string;
  /** Recorder copies only selector and URL, never entered values. */
  args?: Record<string, unknown>;
  success: boolean;
  error?: string;
  urlBefore: string;
  urlAfter: string;
  title?: string;
  tsStart: number;
  tsEnd: number;
  ax: AxObservation;
  screenshot?: string;
  trafficRange: [number, number];
  consoleRange: [number, number];
  /** Legacy monitor samples in existing archives. */
  probes?: Record<string, boolean>;
  probesTruncated?: boolean;
}

export interface CliStepObservation {
  step: number;
  argv: string[];
  stdin?: string;
  stdinTruncated?: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal?: string;
  cwd: string;
  tsStart: number;
  tsEnd: number;
  durationMs: number;
  error?: string;
}
