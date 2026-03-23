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
        name: 'Minimal spec',
        description: 'The smallest valid spec — version, name, target, and one area with a behavior',
        yaml_snippet: `version: "2"\nname: "My App"\ntarget:\n  type: web\n  url: "http://localhost:3000"\nareas:\n  - id: auth\n    name: Authentication\n    behaviors:\n      - id: login-valid-credentials\n        description: A user with valid credentials can log in and sees the dashboard`,
      },
      {
        name: 'Area with multiple behaviors',
        description: 'Areas group behaviors by feature, not by page. Behaviors are plain-language claims about what should be true.',
        yaml_snippet: `areas:
  - id: shopping-cart
    name: Shopping Cart
    behaviors:
      - id: add-item-to-cart
        description: Adding a product increments the cart badge count
      - id: remove-item-from-cart
        description: Removing the last item shows an empty-cart message
      - id: cart-persists-across-sessions
        description: Items in the cart survive a page reload`,
      },
      {
        name: 'Behavior with tags',
        description: 'Use kebab-case IDs. Behaviors describe WHAT should be true, not HOW to verify it. No selectors, matchers, or step sequences.',
        yaml_snippet: `behaviors:
  - id: search-returns-relevant-results
    description: Searching for a product name returns items whose title contains the query
    tags: [search, relevance]
  - id: empty-search-shows-prompt
    description: Submitting an empty search query shows a helpful prompt instead of an error`,
      },
      {
        name: 'CLI target',
        description: 'Spec for a CLI tool — target type is "cli" with a binary path',
        yaml_snippet: `version: "2"
name: "My CLI Tool"
target:
  type: cli
  binary: "node dist/cli.js"
  timeout_ms: 10000
areas:
  - id: help
    name: Help & Usage
    behaviors:
      - id: help-flag-shows-usage
        description: Running with --help prints usage information and exits successfully
      - id: version-flag-shows-version
        description: Running with --version prints a semver version string`,
      },
      {
        name: 'Assumptions and hooks',
        description: 'Preconditions and setup/teardown for the spec',
        yaml_snippet: `assumptions:
  - description: Application is running at the target URL
    check: "curl -sf http://localhost:3000"
  - description: TEST_API_KEY environment variable is set
    check: 'test -n "$TEST_API_KEY"'

hooks:
  setup:
    - name: Seed test database
      run: "npm run db:seed"
  teardown:
    - name: Clean test data
      run: "npm run db:clean"`,
      },
      {
        name: 'Template variables',
        description: 'Dynamic values using template syntax and environment variables',
        yaml_snippet: `variables:
  base_url: "\${TARGET_BASE_URL}"
  api_key: "\${TEST_API_KEY}"
  test_email: "test@example.com"

# Use in specs with double braces:
# {{base_url}}, {{api_key}}, {{test_email}}`,
      },
    ],

    template_variables: {
      syntax: '{{variable_name}} for spec variables, ${ENV_VAR} for environment variables',
      description: 'Variables defined in the "variables" section can be referenced anywhere in the spec using {{name}}. Environment variables use ${NAME} syntax. Hook steps with "save_as" create variables accessible as {{saved_name.field}}.',
    },

    tips: [
      'Start with the minimal spec (version + name + target + one area) and build up incrementally.',
      'Use "specify spec lint" to validate structure before running against a live app.',
      'Areas group behaviors by feature, not by page — think "authentication" or "shopping cart" rather than "/login" or "/cart".',
      'Behaviors are plain-language claims: describe WHAT should be true, not HOW to verify it. No selectors, matchers, or step sequences.',
      'Use kebab-case IDs for areas and behaviors (e.g., "add-item-to-cart", not "addItemToCart").',
      'Use descriptive IDs that read like sentences: "login-valid-credentials", "search-returns-results".',
      'Use the "description" field liberally — it helps both humans and LLMs understand intent.',
      'Add assumptions to prevent false failures (e.g., assert the target URL is reachable first).',
      'Template variables keep specs portable — use ${ENV_VAR} for environment-specific values.',
      'Use "specify spec generate --input <capture-dir>" to generate a spec from captured traffic.',
      'Write descriptions as if briefing an agent: clear enough that an agent can read the requirement, make a plan to validate it, and provide structured evidence without needing to ask for clarification.',
    ],
  };
}
