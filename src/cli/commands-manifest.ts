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
    name: 'capture',
    description: 'Capture a contract from a live system or codebase',
    parameters: [
      { name: '--url', type: 'string', required: false, description: 'URL to capture (required for --from live)' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for capture data (required for --from live)' },
      { name: '--from', type: 'string', required: false, description: 'Source type: live (default) or code', default: 'live' },
      { name: '--input', type: 'string', required: false, description: 'Path to source code (--from code only)' },
      { name: '--framework', type: 'string', required: false, description: 'Test framework: playwright or cypress (--from code only, auto-detected)' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browser visibly (--from live only)' },
      { name: '--timeout', type: 'number', required: false, description: 'Navigation timeout in ms (--from live only)', default: 30000 },
      { name: '--no-screenshots', type: 'boolean', required: false, description: 'Disable screenshots (--from live only)' },
      { name: '--no-generate', type: 'boolean', required: false, description: 'Skip automatic spec generation (--from live only)' },
      { name: '--spec-output', type: 'string', required: false, description: 'Output path for generated spec (default: <output>/../spec.yaml)' },
      { name: '--spec-name', type: 'string', required: false, description: 'Name for the generated spec (default: hostname)' },
      { name: '--interactive', type: 'boolean', required: false, description: 'Open a headed browser for manual recording (--from live only)' },
      { name: '--explore', type: 'boolean', required: false, description: 'Autonomously explore and discover pages (--from live only)' },
    ],
    modes: [
      {
        name: 'from_live',
        description: 'Navigate to URL, record traffic and screenshots (passive, single page)',
        required_parameters: ['--url', '--output'],
        optional_parameters: ['--headed', '--timeout', '--no-screenshots', '--no-generate', '--spec-output', '--spec-name'],
        condition: '--from is "live" or omitted, no --interactive or --explore',
      },
      {
        name: 'from_live_interactive',
        description: 'Open a headed browser for human recording — browse the site and all traffic is captured',
        required_parameters: ['--url', '--output', '--interactive'],
        optional_parameters: ['--timeout', '--no-screenshots', '--no-generate', '--spec-output', '--spec-name'],
        condition: '--interactive is set',
      },
      {
        name: 'from_live_explore',
        description: 'Autonomously discover pages by following links and recording traffic for each',
        required_parameters: ['--url', '--output', '--explore'],
        optional_parameters: ['--headed', '--timeout', '--no-screenshots', '--no-generate', '--spec-output', '--spec-name'],
        condition: '--explore is set',
      },
      {
        name: 'from_code',
        description: 'Import a contract from existing test code',
        required_parameters: ['--input'],
        optional_parameters: ['--framework', '--output'],
        condition: '--from is "code"',
      },
    ],
    examples: [
      'specify capture --url http://localhost:3000 --output ./captures/my-app',
      'specify capture --url http://localhost:3000 --output ./cap --interactive',
      'specify capture --url http://localhost:3000 --output ./cap --explore',
      'specify capture --url https://example.com --output ./cap --no-generate',
      'specify capture --from code --input ./tests --output spec.yaml',
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
    name: 'spec import',
    description: 'Import existing e2e tests as spec items',
    parameters: [
      { name: '--from', type: 'string', required: true, description: 'Path to test file or directory' },
      { name: '--framework', type: 'string', required: false, description: 'Test framework: playwright or cypress (auto-detected if omitted)' },
      { name: '--output', type: 'string', required: false, description: 'Output path for generated spec file' },
    ],
  },
  {
    name: 'spec export',
    description: 'Export spec items as e2e test code',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
      { name: '--framework', type: 'string', required: true, description: 'Target framework: playwright or cypress' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for generated test files' },
      { name: '--split-files', type: 'boolean', required: false, description: 'Generate one file per page/flow' },
    ],
  },
  {
    name: 'spec sync',
    description: 'Compare spec against existing e2e tests bidirectionally',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
      { name: '--tests', type: 'string', required: true, description: 'Path to test directory' },
      { name: '--framework', type: 'string', required: false, description: 'Test framework: playwright or cypress (auto-detected if omitted)' },
    ],
  },
  {
    name: 'spec lint',
    description: 'Validate spec structure without captures (schema + semantic checks)',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
    ],
  },
  {
    name: 'spec guide',
    description: 'Output authoring guide (schema, examples, patterns) for LLM spec writers',
    parameters: [],
  },
  {
    name: 'mcp',
    description: 'Start MCP (Model Context Protocol) server for LLM tool integration',
    parameters: [
      { name: '--http', type: 'boolean', required: false, description: 'Use HTTP transport instead of stdio (for remote access)' },
      { name: '--port', type: 'number', required: false, description: 'Port for HTTP transport (default: 8080)' },
      { name: '--host', type: 'string', required: false, description: 'Host to bind to (default: 0.0.0.0)' },
    ],
    examples: [
      'specify mcp',
      'specify mcp --http --port 3001',
      '{"mcpServers": {"specify": {"command": "specify", "args": ["mcp"]}}}',
      '{"mcpServers": {"specify": {"url": "http://host:8080/mcp"}}}',
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
  {
    name: 'review',
    description: 'Open an interactive spec browser — narrative view with spec toggle and validation results overlay',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file' },
      { name: '--narrative', type: 'string', required: false, description: 'Path to narrative companion file (auto-discovered if omitted)' },
      { name: '--report', type: 'string', required: false, description: 'Path to validation report JSON (gap-report.json or cli-report.json)' },
      { name: '--output', type: 'string', required: false, description: 'Output HTML file path (default: <spec>.review.html)' },
      { name: '--no-open', type: 'boolean', required: false, description: 'Skip auto-opening the browser' },
    ],
    examples: ['specify review --spec spec.yaml', 'specify review --spec spec.yaml --report gap-report.json'],
  },
  {
    name: 'create',
    description: 'Interactive interview that produces a computable spec (YAML) and narrative companion (Markdown)',
    parameters: [
      { name: '--output', type: 'string', required: false, description: 'Output spec file path (default: spec.yaml)' },
      { name: '--narrative', type: 'string', required: false, description: 'Output narrative file path (default: <spec>.narrative.md)' },
    ],
    examples: ['specify create', 'specify create --output my-app.spec.yaml'],
  },
  {
    name: 'verify',
    description: 'Verify an implementation against a contract (data validation, live agent, or CLI)',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
      { name: '--capture', type: 'string', required: false, description: 'Path to capture directory (data validation mode)' },
      { name: '--url', type: 'string', required: false, description: 'Target URL (live agent verification mode)' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for report files' },
      { name: '--history-dir', type: 'string', required: false, description: 'Directory to save report history (data validation mode)' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browser visibly (agent mode)' },
      { name: '--explore', type: 'boolean', required: false, description: 'Enable adaptive exploration (agent mode)' },
      { name: '--max-exploration-rounds', type: 'number', required: false, description: 'Max exploration rounds (agent mode)', default: 2 },
      { name: '--timeout', type: 'number', required: false, description: 'Timeout in ms (agent mode)', default: 300000 },
      { name: '--no-setup', type: 'boolean', required: false, description: 'Skip setup hooks (agent mode)' },
      { name: '--no-teardown', type: 'boolean', required: false, description: 'Skip teardown hooks (agent mode)' },
      { name: '--no-screenshots', type: 'boolean', required: false, description: 'Disable screenshots (agent mode)' },
    ],
    modes: [
      {
        name: 'data_validation',
        description: 'Validate spec against captured data (offline)',
        required_parameters: ['--spec', '--capture'],
        optional_parameters: ['--output', '--history-dir'],
        condition: '--capture is provided (or neither --capture nor --url)',
      },
      {
        name: 'agent_verification',
        description: 'Run autonomous agent-driven verification against a live system',
        required_parameters: ['--spec', '--url'],
        optional_parameters: ['--headed', '--explore', '--max-exploration-rounds', '--timeout', '--no-setup', '--no-teardown', '--no-screenshots', '--output'],
        condition: '--url is provided without --capture',
      },
      {
        name: 'cli_verification',
        description: 'Run CLI verification against spec command definitions (auto-detected when spec has a cli section)',
        required_parameters: ['--spec'],
        optional_parameters: ['--output', '--history-dir'],
        condition: 'Spec has a cli section and neither --url nor --capture is provided',
      },
    ],
    examples: [
      'specify verify --spec spec.yaml --capture ./captures/latest',
      'specify verify --spec spec.yaml --url http://localhost:3000',
      'specify verify --spec spec.yaml   # auto-detects cli section',
    ],
  },
  {
    name: 'lint',
    description: 'Validate contract structure without captures (schema + semantic checks)',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
    ],
    examples: ['specify lint --spec spec.yaml'],
  },
];
