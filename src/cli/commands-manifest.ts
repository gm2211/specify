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
const spec = string('--spec', 'Contract file or directory; auto-discovered when omitted');
/** Public surface: spec authoring and maintenance, without an agent runtime. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'formal check',
    description: 'Check linked Quint models and Lean theorems with external tools',
    parameters: [
      spec,
      string(
        '--timeout-ms',
        'Deadline per formal reference, 1–600000 milliseconds (default 60000)',
      ),
      string('--quint-bin', 'Quint executable (default quint on PATH)'),
      string('--lean-bin', 'Lean executable (default lean on PATH)'),
    ],
  },
  {
    name: 'spec init',
    description: 'Install concise agent instructions for an existing spec',
    parameters: [spec, string('--agents', 'Agent instruction file (default AGENTS.md)')],
  },
  {
    name: 'spec check',
    description: 'Lint specs and require a spec change or explicit unchanged reason',
    parameters: [
      spec,
      string('--base', 'Git base commit for this change', true),
      string('--reason', 'Why this change preserves existing intent'),
    ],
  },
  {
    name: 'spec lint',
    description: 'Validate contract schema, IDs, composition, and size',
    parameters: [spec],
  },
  {
    name: 'spec split',
    description: 'Split a contract into one file per area',
    parameters: [
      spec,
      string('--output', 'Destination directory'),
      flag('--force', 'Allow existing destination'),
    ],
  },
  {
    name: 'spec context',
    description: 'Project contract prose into PRODUCT.md and DESIGN.md',
    parameters: [
      spec,
      string('--out-dir', 'Destination directory'),
      string('--product', 'Product document filename'),
      string('--design', 'Design document filename'),
      flag('--force', 'Replace unmarked documents'),
    ],
  },
  {
    name: 'spec guide',
    description: 'Print contract schema and authoring examples',
    parameters: [],
  },
  {
    name: 'view',
    description: 'Open a local read-only viewer for a spec',
    parameters: [
      spec,
      string('--port', 'Local port (default: choose an available port)'),
      flag('--no-open', 'Print the URL without opening a browser'),
    ],
  },
  {
    name: 'schema',
    description: 'Print spec or commands schema',
    parameters: [string('target', 'spec or commands', true)],
  },
  { name: 'mcp', description: 'Serve contract authoring tools over local stdio', parameters: [] },
];
