import type { CommandDefinition } from './types.js';

/** Command manifest for schema introspection. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'spec validate',
    description: 'Validate a spec against captured data',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
      { name: '--capture', type: 'string', required: true, description: 'Path to capture directory' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for report files' },
      { name: '--history-dir', type: 'string', required: false, description: 'Directory to save report history' },
    ],
  },
  {
    name: 'spec generate',
    description: 'Generate a spec from capture data',
    parameters: [
      { name: '--input', type: 'string', required: true, description: 'Path to capture directory' },
      { name: '--output', type: 'string', required: false, description: 'Output file path' },
      { name: '--name', type: 'string', required: false, description: 'Spec name' },
      { name: '--smart', type: 'boolean', required: false, description: 'Use smart generation' },
    ],
  },
  {
    name: 'spec refine',
    description: 'Refine a spec using a gap report',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file' },
      { name: '--report', type: 'string', required: true, description: 'Path to gap report JSON' },
      { name: '--output', type: 'string', required: false, description: 'Output file path' },
    ],
  },
  {
    name: 'agent run',
    description: 'Run autonomous agent-driven verification',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
      { name: '--url', type: 'string', required: true, description: 'Target base URL' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browser visibly' },
      { name: '--output', type: 'string', required: false, description: 'Output directory' },
      { name: '--explore', type: 'boolean', required: false, description: 'Enable adaptive exploration' },
      { name: '--max-exploration-rounds', type: 'number', required: false, description: 'Max exploration rounds', default: 2 },
      { name: '--timeout', type: 'number', required: false, description: 'Timeout in ms', default: 300000 },
      { name: '--no-setup', type: 'boolean', required: false, description: 'Skip setup hooks' },
      { name: '--no-teardown', type: 'boolean', required: false, description: 'Skip teardown hooks' },
      { name: '--no-screenshots', type: 'boolean', required: false, description: 'Disable screenshots' },
    ],
  },
  {
    name: 'report diff',
    description: 'Diff two gap reports',
    parameters: [
      { name: '--a', type: 'string', required: true, description: 'Path to first report' },
      { name: '--b', type: 'string', required: true, description: 'Path to second report' },
    ],
  },
  {
    name: 'report stats',
    description: 'Show statistical confidence from history',
    parameters: [
      { name: '--history-dir', type: 'string', required: true, description: 'Path to history directory' },
    ],
  },
  {
    name: 'schema',
    description: 'Output JSON Schema for spec, report, or commands',
    parameters: [
      { name: 'target', type: 'string', required: true, description: 'Schema target: spec, report, or commands' },
    ],
  },
  {
    name: 'human',
    description: 'Interactive mode — context-aware wizard that detects project state and guides you',
    parameters: [
      { name: '--from-capture', type: 'string', required: false, description: 'Pre-populate wizard from capture directory' },
    ],
    examples: ['specify human', 'specify human shell --spec spec.yaml', 'specify human watch --spec spec.yaml --url http://localhost:3000'],
  },
  {
    name: 'human shell',
    description: 'Interactive REPL for iterative spec development with tab completion',
    parameters: [
      { name: '--spec', type: 'string', required: false, description: 'Initial spec to load' },
      { name: '--url', type: 'string', required: false, description: 'Target URL' },
    ],
  },
  {
    name: 'human watch',
    description: 'Live TUI dashboard for monitoring agent runs and spec status',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file' },
      { name: '--url', type: 'string', required: true, description: 'Target URL' },
    ],
  },
];
