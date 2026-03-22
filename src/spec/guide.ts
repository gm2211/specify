/**
 * src/spec/guide.ts — Authoring guide for LLM spec writers
 *
 * Assembles a self-contained document with schema, examples, patterns,
 * and tips that an LLM needs to write valid Specify specs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { specSchema } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthoringGuide {
  /** Full JSON Schema for the spec format. */
  schema: typeof specSchema;

  /** Complete example specs with explanations. */
  examples: Array<{
    name: string;
    description: string;
    yaml: string;
  }>;

  /** Annotated mini-patterns showing common constructs. */
  patterns: Array<{
    name: string;
    description: string;
    yaml_snippet: string;
  }>;

  /** Enumeration of all assertion and step types. */
  assertion_types: {
    visual_assertions: string[];
    scenario_step_actions: string[];
    cli_output_assertions: string[];
    flow_step_types: string[];
    hook_types: string[];
    assumption_types: string[];
  };

  /** How template variables work. */
  template_variables: {
    syntax: string;
    description: string;
  };

  /** Best practices and tips. */
  tips: string[];
}

// ---------------------------------------------------------------------------
// Example loader
// ---------------------------------------------------------------------------

function loadExamples(): AuthoringGuide['examples'] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const examplesDir = path.join(__dirname, 'examples');

  // In dist/ the .yaml files won't be there — walk up to project root and find src/
  // __dirname at runtime is either src/spec (dev) or dist/src/spec (built)
  const projectRoot = __dirname.includes('/dist/')
    ? __dirname.split('/dist/')[0]
    : path.resolve(__dirname, '../..');
  const srcExamplesDir = path.join(projectRoot, 'src', 'spec', 'examples');
  const dir = fs.existsSync(examplesDir) ? examplesDir : srcExamplesDir;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort();

  const descriptions: Record<string, string> = {
    'login-page.yaml': 'Simple single-page spec with form interactions, scenarios (success + error paths), and template variables',
    'dashboard-api.yaml': 'Page with API request assertions, JSON Schema validation on responses, interactive scenarios with wait_for_request',
    'multi-page-flow.yaml': 'Multi-page e-commerce flow with setup/teardown hooks, navigation steps, and cross-page assertions',
  };

  return files.map(f => ({
    name: f.replace(/\.ya?ml$/, '').replace(/-/g, ' '),
    description: descriptions[f] ?? `Example spec: ${f}`,
    yaml: fs.readFileSync(path.join(dir, f), 'utf-8'),
  }));
}

// ---------------------------------------------------------------------------
// Guide assembly
// ---------------------------------------------------------------------------

export function getAuthoringGuide(): AuthoringGuide {
  return {
    schema: specSchema,

    examples: loadExamples(),

    patterns: [
      {
        name: 'Minimal valid spec',
        description: 'The smallest possible valid spec — just version and name',
        yaml_snippet: `version: "1.0"\nname: "My App Spec"`,
      },
      {
        name: 'Page with visual assertions',
        description: 'A page that checks for specific elements and text on screen',
        yaml_snippet: `pages:
  - id: login
    path: /login
    title: "Login"
    visual_assertions:
      - type: element_exists
        selector: "form#login-form"
        description: "Login form is present"
      - type: text_contains
        selector: "h1"
        text: "Welcome"
      - type: element_count
        selector: ".nav-item"
        min: 3
        max: 10`,
      },
      {
        name: 'Scenario with interaction steps',
        description: 'A scenario testing a user workflow on a page',
        yaml_snippet: `scenarios:
  - id: submit-form
    description: "User fills and submits the form"
    steps:
      - action: fill
        selector: "#email"
        value: "user@example.com"
      - action: fill
        selector: "#password"
        value: "secret123"
      - action: click
        selector: "button[type=submit]"
      - action: wait_for_navigation
        url_pattern: "/dashboard"
      - action: assert_visible
        selector: ".welcome-message"`,
      },
      {
        name: 'API request assertions',
        description: 'Assert that a page makes specific API calls with expected response shapes',
        yaml_snippet: `expected_requests:
  - method: GET
    url_pattern: "/api/users"
    description: "Fetches user list"
    response:
      status: 200
      content_type: "application/json"
      body_schema:
        type: object
        required: [items, total]
        properties:
          items:
            type: array
          total:
            type: number`,
      },
      {
        name: 'Multi-page flow',
        description: 'A flow that navigates across multiple pages with assertions at each step',
        yaml_snippet: `flows:
  - id: checkout-flow
    description: "User completes a purchase"
    steps:
      - navigate: /products
      - assert_page: product-list
      - action: click
        selector: ".add-to-cart"
      - navigate: /cart
      - assert_page: cart
      - action: click
        selector: "#checkout"
      - action: wait_for_navigation
        url_pattern: "/checkout"
      - assert_page: checkout`,
      },
      {
        name: 'Setup and teardown hooks',
        description: 'Hooks to create/clean test data before and after verification',
        yaml_snippet: `hooks:
  setup:
    - name: "Create test user"
      type: api_call
      method: POST
      url: "{{base_url}}/api/test/users"
      body:
        email: "test@example.com"
      save_as: test_user
    - name: "Reset database"
      type: shell
      command: "npm run db:seed"
  teardown:
    - name: "Delete test user"
      type: api_call
      method: DELETE
      url: "{{base_url}}/api/test/users/{{test_user.id}}"`,
      },
      {
        name: 'CLI verification',
        description: 'Spec for validating a CLI tool\'s output, exit codes, and behavior',
        yaml_snippet: `cli:
  binary: "node dist/cli.js"
  timeout_ms: 10000
  commands:
    - id: help
      description: "Help flag shows usage"
      args: ["--help"]
      expected_exit_code: 0
      stderr_assertions:
        - type: text_contains
          text: "Usage:"
    - id: version
      args: ["--version"]
      expected_exit_code: 0
      stdout_assertions:
        - type: text_matches
          pattern: "^\\\\d+\\\\.\\\\d+\\\\.\\\\d+$"
    - id: invalid-input
      args: ["--nonexistent"]
      expected_exit_code: 1
      stderr_assertions:
        - type: text_contains
          text: "Unknown option"`,
      },
      {
        name: 'Narrative sections with embedded requirements',
        description: 'Embed prose and requirements directly in the spec YAML instead of a separate markdown file',
        yaml_snippet: `narrative:
  - section: "Capture & Spec Generation"
    prose: >
      The tool captures live application behavior and generates
      machine-verifiable specs from observed interactions.
    requirements:
      - id: capture-autonomous-exploration
        description: >
          Autonomous capture mode discovers pages and interactions
          without human guidance.
        narrative: >
          This is the core value prop — zero-effort spec generation.
        verification: agent
        validation_plan: |
          1. Start capture in autonomous mode
          2. Verify discovered pages match known app routes
    covers:
      - capture-no-url
      - capture-invalid-url
  - section: "Verification"
    prose: >
      Verification validates that application behavior matches
      spec requirements using both mechanical and agent-based checks.
    requirements:
      - id: closed-world-verification
        description: >
          All claims must be grounded by passing checks.
        verification: mechanical`,
      },
      {
        name: 'Defaults and assumptions',
        description: 'Global properties and preconditions for the spec',
        yaml_snippet: `defaults:
  no_5xx: true
  no_console_errors: true
  no_uncaught_exceptions: true
  page_load_timeout_ms: 5000

assumptions:
  - type: url_reachable
    url: "{{base_url}}"
    description: "Application is running"
  - type: env_var_set
    name: "TEST_API_KEY"
    description: "API key is configured"`,
      },
      {
        name: 'Template variables',
        description: 'Dynamic values using template syntax and environment variables',
        yaml_snippet: `variables:
  base_url: "\${TARGET_BASE_URL}"
  api_key: "\${TEST_API_KEY}"
  test_email: "test@example.com"

# Use in specs with double braces:
# {{base_url}}, {{api_key}}, {{test_email}}
# Hook results: {{test_user.id}} (from save_as: test_user)`,
      },
    ],

    assertion_types: {
      visual_assertions: [
        'element_exists — Check that a CSS selector matches an element in the DOM',
        'text_contains — Check that an element\'s text includes a substring',
        'text_matches — Check that an element\'s text matches a regex pattern',
        'screenshot_region — Visual regression check on a page region',
        'element_count — Check the count of elements matching a selector (min/max)',
      ],
      scenario_step_actions: [
        'click — Click an element (requires selector)',
        'fill — Type text into an input (requires selector + value)',
        'select — Choose a dropdown option (requires selector + value)',
        'hover — Hover over an element (requires selector)',
        'wait_for_request — Wait for a network request (requires url_pattern, optional method)',
        'wait_for_navigation — Wait for page navigation (requires url_pattern)',
        'assert_visible — Assert an element is visible (requires selector)',
        'assert_text — Assert element contains text (requires selector + text)',
        'assert_not_visible — Assert an element is NOT visible (requires selector)',
        'keypress — Press a key (requires key, e.g. "Enter", "Control+A")',
        'scroll — Scroll to element or position (optional selector or direction: top/bottom)',
        'wait — Wait for a duration in ms (requires duration)',
      ],
      cli_output_assertions: [
        'text_contains — Output contains a substring',
        'text_matches — Output matches a regex pattern',
        'json_schema — Output is valid JSON matching a JSON Schema',
        'json_path — A specific JSON path has an expected value',
        'empty — Output is empty',
        'line_count — Output has a specific number of lines (min/max)',
      ],
      flow_step_types: [
        'navigate — Navigate to a URL path',
        'assert_page — Assert current page matches a PageSpec by id',
        'action — Perform an interactive action (same types as scenario steps)',
      ],
      hook_types: [
        'api_call — Make an HTTP request (method, url, headers, body, save_as)',
        'shell — Run a shell command (command, save_as)',
      ],
      assumption_types: [
        'url_reachable — A URL responds with 2xx to a HEAD request',
        'env_var_set — An environment variable is set and non-empty',
        'api_returns — An API endpoint returns an expected status code',
        'selector_exists — A CSS selector exists on a given page',
      ],
    },

    template_variables: {
      syntax: '{{variable_name}} for spec variables, ${ENV_VAR} for environment variables',
      description: 'Variables defined in the "variables" section can be referenced anywhere in the spec using {{name}}. Environment variables use ${NAME} syntax. Hook steps with "save_as" create variables accessible as {{saved_name.field}}.',
    },

    tips: [
      'Start with the minimal spec (version + name) and build up incrementally.',
      'Use "specify spec lint" to validate structure before running against a live app.',
      'Every page should have at least one visual assertion — otherwise there\'s nothing to verify.',
      'Scenarios should end with an assertion step (assert_visible, assert_text) to verify the outcome.',
      'Use descriptive IDs that read like sentences: "login", "successful-checkout", "filter-by-date".',
      'Use the "description" field liberally — it helps both humans and LLMs understand intent.',
      'Set defaults (no_5xx, no_console_errors) to catch common regressions across all pages.',
      'Add assumptions to prevent false failures (e.g., assert the target URL is reachable first).',
      'For CLI specs, test both happy paths (exit 0) and error paths (non-zero exit codes).',
      'Use json_path assertions to check specific JSON output values without validating the entire structure.',
      'Template variables keep specs portable — use ${ENV_VAR} for environment-specific values.',
      'Flows connect pages into user journeys — use assert_page to verify you landed on the right page.',
      'The "quantifier" field (always/sometimes) marks whether an assertion must hold on every run or just some.',
      'The "confidence" field (observed/inferred/reviewed) tracks how an assertion was established.',
      'A spec is a behavioral contract, not just a test suite. Include both mechanically verifiable assertions (exit codes, json_path) AND behavioral requirements that describe what should be true — agents will figure out how to validate them.',
      'For behavioral requirements that need judgment to verify, include a validation plan in comments: what steps an agent should take, what evidence to produce, and what "passing" looks like.',
      'Write descriptions as if briefing an agent: clear enough that an agent can read the requirement, make a plan to validate it, and provide structured evidence without needing to ask for clarification.',
      'To verify a behavioral requirement, agents write evidence to .specify/evidence/<requirement-id>.json with format: { requirement_id, status: "passed"|"failed", timestamp, agent, evidence: { ... } }. The verify command reads this file and marks the requirement accordingly.',
      'Use the top-level "narrative" field to embed prose sections directly in the spec YAML — this keeps human-readable context co-located with the requirements it describes, eliminating the need for a separate narrative markdown file.',
      'Each narrative section can define requirements inline and reference other spec items via "covers" — this groups related concerns while keeping the spec as the single source of truth.',
      'Use "specify capture --url <url>" for autonomous agent-driven capture, or "specify capture --url <url> --human" to open a headed browser for manual recording.',
      'Use "specify verify --history-dir .specify/history" to save verification results, then "specify report stats --history-dir .specify/history" to see statistical confidence grow over time.',
    ],
  };
}
