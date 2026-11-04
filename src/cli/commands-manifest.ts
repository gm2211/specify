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

/** Public surface: formal checks for OpenSpec requirements, plus project setup. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'init',
    description: 'Set up OpenSpec, a formal/ folder, and agent instructions in a project',
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
      string('--timeout-ms', 'Deadline per check, 1–600000 milliseconds (default 60000)'),
      string('--quint-bin', 'Quint executable (default quint on PATH)'),
      string('--lean-bin', 'Lean executable (default lean on PATH)'),
    ],
  },
];
