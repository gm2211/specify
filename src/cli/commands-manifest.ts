import type { CommandDefinition } from './types.js';

/** Command manifest for schema introspection. */
export const COMMANDS: CommandDefinition[] = [
  {
    name: 'capture',
    description: 'Capture a contract from a live system or codebase',
    parameters: [
      { name: '--url', type: 'string', required: true, description: 'URL to capture' },
      { name: '--output', type: 'string', required: false, description: 'Output directory for capture data' },
      { name: '--headed', type: 'boolean', required: false, description: 'Run browser visibly' },
      { name: '--spec-output', type: 'string', required: false, description: 'Output path for generated spec (default: <output>/../spec.yaml)' },
      { name: '--spec-name', type: 'string', required: false, description: 'Name for the generated spec (default: hostname)' },
      { name: '--storage-state', type: 'string', required: false, description: 'Playwright storage-state JSON, as a filesystem path or keychain:<name> (macOS Keychain); loaded into the browser context so the run starts authenticated' },
      { name: '--save-storage-state', type: 'string', required: false, description: 'Where to write the browser context storage state (cookies + localStorage) after the run completes, as a filesystem path or keychain:<name> (macOS Keychain)' },
    ],
    examples: [
      'specify capture --url http://localhost:3000 --output ./captures/my-app',
      'specify capture --url http://localhost:3000 --output ./cap --storage-state .auth/storage-state.json',
      'specify capture --url http://localhost:3000 --output ./cap --headed --save-storage-state keychain:my-app-session',
    ],
  },
  {
    name: 'schema',
    description: 'Output JSON Schema for spec or commands',
    parameters: [
      { name: 'target', type: 'string', required: true, description: 'Schema target: spec or commands' },
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
    name: 'spec context',
    description: 'Generate/refresh PRODUCT.md and DESIGN.md from the composed spec — deterministic projection, every claim traced to its source area/behavior id',
    parameters: [
      { name: '--spec', type: 'string', required: false, description: 'Path to spec file or directory (auto-discovered if omitted)' },
      { name: '--out-dir', type: 'string', required: false, description: 'Output directory for generated files', default: '.' },
      { name: '--product', type: 'string', required: false, description: 'Output path (relative to --out-dir) for the product-doctrine file', default: 'PRODUCT.md' },
      { name: '--design', type: 'string', required: false, description: 'Output path (relative to --out-dir) for the design-context file', default: 'DESIGN.md' },
      { name: '--force', type: 'boolean', required: false, description: 'Overwrite a target file in place even when it has no specify managed-region markers (destroys unmanaged hand edits); default writes a reviewable <name>.proposed<ext> file instead' },
    ],
    examples: [
      'specify spec context',
      'specify spec context --spec spec/ --out-dir docs',
      'specify spec context --json',
    ],
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
      { name: '--host', type: 'string', required: false, description: 'Host to bind to (unauthenticated API — widen beyond localhost only if you mean to); also settable via SPECIFY_REVIEW_HOST', default: '127.0.0.1' },
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
      'specify review --spec spec.yaml --host 0.0.0.0',
    ],
  },
  {
    name: 'prove',
    description: 'Write a self-contained proof.html from a verify run — evidence badged runner-recorded vs agent-reported, filmstrip / terminal replay, integrity footer',
    parameters: [
      { name: '--spec', type: 'string', required: false, description: 'Path to spec file (auto-discovered if omitted)' },
      { name: '--input', type: 'string', required: false, description: 'Verify output directory to read', default: '.specify/verify' },
      { name: '--output', type: 'string', required: false, description: 'Output path for proof.html', default: '<input>/proof.html' },
      { name: '--max-screenshot-bytes', type: 'number', required: false, description: 'Base64-encoded screenshot byte budget before falling back to linked files', default: 41943040 },
    ],
    examples: [
      'specify prove',
      'specify prove --spec specify.spec --input .specify/verify',
      'specify prove --output ./proof.html --json',
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
      { name: '--storage-state', type: 'string', required: false, description: 'Playwright storage-state JSON, as a filesystem path or keychain:<name> (macOS Keychain); loaded into the browser context so the run starts authenticated' },
    ],
    examples: [
      'specify verify --spec spec.yaml --url http://localhost:3000',
      'specify verify --spec spec.yaml',
      'specify verify --spec spec.yaml --mode scripted',
      'specify verify --spec spec.yaml --mode auto',
      'specify verify --spec spec.yaml --cross-check',
    ],
  },
  {
    name: 'deploy describe',
    description: 'Print the self-describing Terraform install manifest for the specify-qa module (image, module source, oneof variable groups, target contract, agent tools, secrets, outputs, agent-install recipe, worked examples)',
    parameters: [
      { name: '--format', type: 'string', required: false, description: 'Output format: json (default) or text', default: 'json' },
    ],
    examples: [
      'specify deploy describe',
      'specify deploy describe --format text',
    ],
  },
  {
    name: 'deploy print-tf',
    description: 'Emit a working Terraform snippet for one of the built-in specify-qa deployment presets',
    parameters: [
      { name: 'preset', type: 'string', required: false, description: 'Preset name: minimal (default), watch-mode, webhook-mode, or gitops-spec', default: 'minimal' },
    ],
    examples: [
      'specify deploy print-tf',
      'specify deploy print-tf minimal',
      'specify deploy print-tf watch-mode',
      'specify deploy print-tf webhook-mode',
      'specify deploy print-tf gitops-spec',
    ],
  },
];
