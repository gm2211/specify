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

/** Public surface: contract tools and caller-owned evidence, without an agent runtime. */
export const COMMANDS: CommandDefinition[] = [
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
    name: 'schema',
    description: 'Print spec or commands schema',
    parameters: [string('target', 'spec or commands', true)],
  },
  {
    name: 'verify',
    description:
      'Check external results against every contract ID; scripted mode runs a caller-owned suite',
    parameters: [
      spec,
      string('--report', 'External JSON results file'),
      string('--mode', 'results (default) or scripted'),
      string('--output', 'Scripted suite directory (default .specify/verify)'),
      string('--timeout', 'Scripted suite timeout in milliseconds'),
    ],
  },
  {
    name: 'prove',
    description:
      'Render recorded results as self-contained HTML; rendering success is not verification success',
    parameters: [
      spec,
      string('--input', 'Directory containing verify-result.json'),
      string('--output', 'HTML destination'),
      string('--max-screenshot-bytes', 'Maximum embedded screenshot bytes'),
    ],
  },
  { name: 'mcp', description: 'Serve contract authoring tools over local stdio', parameters: [] },
];
