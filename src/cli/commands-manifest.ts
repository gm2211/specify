import type { CommandDefinition, ParameterDefinition } from './types.js';

const string = (name: string, description: string, required = false): ParameterDefinition => ({
  name,
  description,
  required,
  type: 'string',
});
const flag = (name: string, description: string): ParameterDefinition => ({
  name,
  description,
  required: false,
  type: 'boolean',
});
const root = string('--root', 'Project root containing openspec/ (default: current directory)');

const timeout = string('--timeout-ms', 'Deadline per check, 1–600000 milliseconds (default 60000)');
const quintBin = string('--quint-bin', 'Quint executable (default quint on PATH)');
const leanBin = string('--lean-bin', 'Lean executable (default lean on PATH)');

/** Public surface: the gate and formal checks for OpenSpec requirements, plus project setup. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'init',
    description: 'Set up OpenSpec, formal/, the gate policy, agent instructions and hooks',
    parameters: [
      root,
      string('--agents', 'Agent instruction file (default AGENTS.md under the root)'),
      string('--tools', 'Tools passed to `openspec init --tools` (default claude)'),
      string('--openspec-bin', 'OpenSpec executable (default openspec on PATH, else npx)'),
      flag('--skip-openspec', 'Do not run openspec init'),
    ],
  },
  {
    name: 'formal check',
    description: 'Run the Quint and Lean checks linked from OpenSpec requirements',
    parameters: [
      root,
      string('--tool', 'Run only quint or only lean links'),
      string('--change', 'Include an OpenSpec change: its delta specs override the main specs'),
      timeout,
      quintBin,
      leanBin,
    ],
  },
  {
    name: 'gate',
    description:
      'One verdict: formal checks, coverage policy, Verify test results and the drift lock',
    parameters: [
      root,
      string('--policy', 'strict or warn (default: formal/specify.json, else warn)'),
      flag('--changed', 'Run only checks whose spec or model differs from the base ref'),
      string('--base', 'Git ref the drift lock and --changed compare against (default HEAD)'),
      flag('--skip-verify', 'Do not require test results for Verify lines'),
      string('--test-report', 'Comma-separated JUnit XML or TAP files (default: config)'),
      string('--hook', 'stop or pre-push: report on stderr; a missing tool does not block'),
      string('--tool', 'Run only quint or only lean links'),
      timeout,
      quintBin,
      leanBin,
    ],
  },
  {
    name: 'lock',
    description: 'Write formal/specify.lock: each link, its expectation and property text hash',
    parameters: [root],
  },
  {
    name: 'trace export',
    description: 'Write ITF traces of the Quint models for conformance tests to replay',
    parameters: [
      root,
      string('--out', 'Output directory (default formal/traces)'),
      string('--traces', 'Traces per model (default 10)'),
      string('--max-steps', 'Steps per trace (default 20)'),
      string('--seed', 'Random seed (default 1)'),
      quintBin,
    ],
  },
];
