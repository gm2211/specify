import type { CommandDefinition } from './types.js';

/** Command manifest for schema introspection. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'spec generate',
    description: 'Generate a spec from capture data',
    parameters: [
      { name: '--input', type: 'string', required: true, description: 'Path to capture directory' },
      { name: '--output', type: 'string', required: false, description: 'Output file path' },
      { name: '--name', type: 'string', required: false, description: 'Spec name' },
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
      { name: '--human', type: 'boolean', required: false, description: 'Open a headed browser for human recording instead of autonomous agent' },
    ],
    modes: [
      {
        name: 'agent',
        description: 'Autonomous agent explores and documents the application using Claude Agent SDK (default)',
        required_parameters: ['--url'],
        optional_parameters: ['--output', '--headed', '--spec-output', '--spec-name'],
        condition: '--from is "live" or omitted, no --human',
      },
      {
        name: 'human',
        description: 'Open a headed browser for human recording — browse the site and all traffic is captured',
        required_parameters: ['--url', '--output', '--human'],
        optional_parameters: ['--timeout', '--no-screenshots', '--no-generate', '--spec-output', '--spec-name'],
        condition: '--human is set',
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
      'specify capture --url http://localhost:3000 --output ./cap --human',
      'specify capture --url https://example.com --output ./cap --no-generate',
      'specify capture --from code --input ./tests --output spec.yaml',
    ],
  },
  {
    name: 'replay',
    description: 'Replay captured traffic against a target and diff the results',
    parameters: [
      { name: '--capture', type: 'string', required: true, description: 'Path to capture directory' },
      { name: '--url', type: 'string', required: true, description: 'Target URL to replay against' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browser visibly' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for diff report' },
    ],
    examples: [
      'specify replay --capture ./captures/baseline --url http://localhost:3000',
    ],
  },
  {
    name: 'compare',
    description: 'Live side-by-side comparison of remote and local targets using parallel browser sessions',
    parameters: [
      { name: '--remote', type: 'string', required: true, description: 'Remote target URL' },
      { name: '--local', type: 'string', required: true, description: 'Local target URL' },
      { name: '--remote-auth', type: 'string', required: false, description: 'HTTP Basic Auth for remote (user:pass)' },
      { name: '--local-auth', type: 'string', required: false, description: 'HTTP Basic Auth for local (user:pass)' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for comparison report' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browsers visibly' },
    ],
    examples: [
      'specify compare --remote https://prod.example.com --local http://localhost:3000',
      'specify compare --remote https://staging.example.com --local http://localhost:3000 --headed',
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
    name: 'spec lint',
    description: 'Validate spec structure without captures (schema + semantic checks)',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to spec file (or - for stdin)' },
    ],
  },
  {
    name: 'spec split',
    description: 'Convert a large single-file spec into a directory spec with one file per area',
    parameters: [
      { name: '--spec', type: 'string', required: true, description: 'Path to the single-file spec to split' },
      { name: '--output', type: 'string', required: false, description: 'Output spec directory (default: extensionless spec path)' },
      { name: '--force', type: 'boolean', required: false, description: 'Allow writing into an existing non-empty output directory' },
    ],
    examples: [
      'specify spec split --spec spec.yaml --output spec/',
      'specify spec split --spec argos.spec.yaml',
    ],
  },
  {
    name: 'spec migrate-id',
    description: 'Rewrite learned-state keys (confidence.json, observations, memory) after a behavior/area id rename',
    parameters: [
      { name: 'old-fq-id', type: 'string', required: true, description: 'Current fully-qualified id being renamed, "area/behavior"' },
      { name: 'new-fq-id', type: 'string', required: true, description: 'New fully-qualified id, "area/behavior"' },
      { name: '--spec', type: 'string', required: false, description: 'Path to spec file (auto-discovered if omitted)' },
    ],
    examples: [
      'specify spec migrate-id auth/login auth/signin',
    ],
  },
  {
    name: 'spec guide',
    description: 'Output authoring guide (schema, examples, patterns) for LLM spec writers',
    parameters: [],
  },
  {
    name: 'spec compile',
    description: 'Compile plain-language behaviors into LTLf formulas (specify.formulas.yaml) via an offline, browserless LLM agent. Behaviors the model cannot compile faithfully are honestly skipped, not forced.',
    parameters: [
      { name: '--spec', type: 'string', required: false, description: 'Path to spec file (auto-discovered if omitted)' },
      { name: '--behavior', type: 'string', required: false, description: 'Fully-qualified area/behavior id to compile; repeatable to filter to a subset' },
      { name: '--force', type: 'boolean', required: false, description: 'Recompile behaviors that already have a formula entry (default: skip them)' },
    ],
    examples: [
      'specify spec compile --spec spec.yaml',
      'specify spec compile --behavior auth/login --behavior auth/logout',
      'specify spec compile --force',
    ],
  },
  {
    name: 'daemon',
    description: 'Long-running Specify process with HTTP inbox. Idle = 0 tokens. Accepts tasks pushed by other agents.',
    parameters: [
      { name: '--port', type: 'number', required: false, description: 'Port to listen on', default: 4100 },
      { name: '--host', type: 'string', required: false, description: 'Host to bind to', default: '127.0.0.1' },
      { name: '--no-auth', type: 'boolean', required: false, description: 'Disable bearer-token auth (trusted localhost only)' },
      { name: '--max-workers', type: 'number', required: false, description: 'Max concurrent forked worker processes for stateless jobs', default: 2 },
    ],
    examples: [
      'specify daemon',
      'specify daemon --port 4100 --max-workers 4',
      'curl -H "Authorization: Bearer $(cat ~/.specify/daemon.token)" \\',
      '     -d \'{"task":"freeform","prompt":"lint spec.yaml"}\' http://localhost:4100/inbox',
    ],
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
    description: 'Interactive chat REPL — freeform text interface for working with Specify',
    parameters: [
      { name: '--spec', type: 'string', required: false, description: 'Initial spec to load' },
      { name: '--url', type: 'string', required: false, description: 'Target URL' },
    ],
    examples: ['specify human', 'specify human --spec spec.yaml', 'specify human --spec spec.yaml --url http://localhost:3000'],
  },
  {
    name: 'review',
    description: 'Open the interactive spec browser (narrative view, validation overlay, live reload)',
    parameters: [
      { name: '--spec', type: 'string', required: false, description: 'Path to spec file (auto-discovered if omitted)' },
      { name: '--port', type: 'number', required: false, description: 'Port to listen on', default: 3000 },
      { name: '--agent-report', type: 'string', required: false, description: 'Path to agent verification result JSON (from specify verify --url)' },
      { name: '--no-open', type: 'boolean', required: false, description: 'Skip auto-opening the browser' },
      { name: '--background', type: 'boolean', required: false, description: 'Daemonize the server; writes .specify/ui.pid' },
      { name: '--stop', type: 'boolean', required: false, description: 'Kill a backgrounded server (reads .specify/ui.pid)' },
    ],
    examples: [
      'specify review --spec spec.yaml',
      'specify review --spec spec.yaml --background',
      'specify review --stop',
      'specify review --spec spec.yaml --agent-report .specify/verify/verify-result.json',
    ],
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
      { name: '--url', type: 'string', required: false, description: 'Target URL (for web/api specs)' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for report files' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browser visibly' },
      { name: '--mode', type: 'string', required: false, description: 'Verification tier: agent (default), scripted (replay generated tests only, no LLM), or auto (confidence-driven routing: high-confidence behaviors with fresh passing tests replay scripted, everything else goes to the agent; scripted failures still escalate)' },
      { name: '--cross-check', type: 'boolean', required: false, description: 'After the agent run, replay the generated suite and report agent/test agreement as cross_check in verify-result.json (report-only, never changes pass/fail)' },
      { name: '--route-all-scripted', type: 'boolean', required: false, description: 'With --mode auto: skip confidence-driven routing and run the FULL scripted suite first, escalating failures/untested to the agent (the pre-routing behavior)' },
    ],
    examples: [
      'specify verify --spec spec.yaml --url http://localhost:3000',
      'specify verify --spec spec.yaml',
      'specify verify --spec spec.yaml --mode scripted',
      'specify verify --spec spec.yaml --mode auto',
      'specify verify --spec spec.yaml --cross-check',
    ],
  },
];
