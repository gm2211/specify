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

  /** Agent-executed review protocol; not a semantic checker or test runner. */
  workflow: Record<'capture' | 'review' | 'reconcile', string[]>;
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

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const descriptions: Record<string, string> = {
    'login-page.yaml':
      'Authentication behaviors with success and rejection cases and template variables',
    'dashboard-api.yaml':
      'Dashboard and API behavior claims, including authorization and response expectations',
    'multi-page-flow.yaml':
      'Checkout behavior claims with preconditions and cross-feature expectations',
    'formal.yaml':
      'A behavior linked to Quint simulation and bounded verification plus a Lean theorem',
  };

  return files.map((f) => ({
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
        description:
          'The smallest valid spec — version, name, target, and one area with a behavior',
        yaml_snippet: `version: "2"\nname: "My App"\ntarget:\n  type: web\n  url: "http://localhost:3000"\nareas:\n  - id: auth\n    name: Authentication\n    behaviors:\n      - id: login-valid-credentials\n        description: A user with valid credentials can log in and sees the dashboard`,
      },
      {
        name: 'Area with multiple behaviors',
        description:
          'Areas group behaviors by feature, not by page. Behaviors are plain-language claims about what should be true.',
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
        name: 'Behavior with title and rationale',
        description:
          'Use title as a human label and rationale to record why the behavior matters. Keep the precise contract in description.',
        yaml_snippet: `behaviors:
  - id: search-stays-local
    title: Keep searches private
    description: Search terms remain in the browser and are never sent to a server
    rationale: People may search for sensitive topics and need confidence their queries stay private.`,
      },
      {
        name: 'Behavior with source wording',
        description:
          'Keep canonical intent in the behavior and preserve original wording as optional source metadata.',
        yaml_snippet: `behaviors:
  - id: search-stays-local
    description: Search terms remain in the browser and are never sent to a server
    source:
      text: "Please keep search terms in this browser."
      reference: "product discussion, 2026-10-01"`,
      },
      {
        name: 'Behavior with tags',
        description:
          'Use kebab-case IDs. Behaviors describe WHAT should be true, not HOW to verify it. No selectors, matchers, or step sequences.',
        yaml_snippet: `behaviors:
  - id: search-returns-relevant-results
    description: Searching for a product name returns items whose title contains the query
    tags: [search, relevance]
  - id: empty-search-shows-prompt
    description: Submitting an empty search query shows a helpful prompt instead of an error`,
      },
      {
        name: 'Behavior with linked formal properties',
        description:
          'Link authored model properties explicitly. Quint checks are seeded simulations or bounded verification; Lean links a public theorem. Results concern these models, not the prose or application.',
        yaml_snippet: `behaviors:
  - id: count-never-negative
    description: The counter starts at zero, stays nonnegative, and each increment increases it by one.
    formal:
      - tool: quint
        file: formal/Counter.qnt
        property: nonNegative
        mode: verify
        maxSteps: 8
      - tool: quint
        file: formal/Counter.qnt
        property: nonNegative
        mode: simulate
        maxSteps: 8
        samples: 20
        seed: 17
      - tool: lean
        file: formal/Counter.lean
        property: Counter.incrementPreservesNonnegative`,
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
        description:
          'Legacy precondition and hook metadata for external runners; Specify does not execute these commands',
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
      description:
        'Variables defined in the "variables" section can be referenced anywhere in the spec using {{name}}. Environment variables use ${NAME} syntax. Legacy hook save_as names can be referenced as {{saved_name.field}}; execution and substitution are the external runner responsibility.',
    },

    tips: [
      'Keep behavior IDs stable across edits; rename only when behavior itself changes, and update references in specs and tests.',
      'Large directory area fragments get advisory size warnings; keep area requirements readable and preserve behavior IDs instead of splitting one area across duplicate IDs.',
      'Areas and tags organize requirements, not code-change impact or feature dependencies.',
      'Start with the minimal spec (version + name + target + one area) and build up incrementally.',
      'Use "specify spec lint" to validate structure before external tests or review.',
      'Areas group behaviors by feature, not by page — think "authentication" or "shopping cart" rather than "/login" or "/cart".',
      'Behaviors are plain-language claims: describe WHAT should be true, not HOW to verify it. No selectors, matchers, or step sequences.',
      'Use kebab-case IDs for areas and behaviors (e.g., "add-item-to-cart", not "addItemToCart").',
      'Use descriptive IDs that read like sentences: "login-valid-credentials", "search-returns-results".',
      'Project description and area prose explain the outcome and purpose. A behavior title is a short human label; description is the precise contract; rationale explains why it matters and any known tradeoffs.',
      'Write rationale only from known intent. Label assumptions clearly; rationale is not test evidence or a place to copy source wording.',
      'Add assumptions to prevent false failures (e.g., assert the target URL is reachable first).',
      'Template variables keep specs portable — use ${ENV_VAR} for environment-specific values.',
      'Draft contracts with your preferred editor or coding agent; Specify validates structure while people and external tools own implementation and testing.',
      'Link Quint and Lean properties only when a model or theorem has been authored and reviewed. Run "specify formal check --spec PATH"; read docs/formal.md for tool setup and limits. A passing model check is not proof that prose or application behavior is correct.',
      'Write descriptions as if briefing an agent: clear enough to guide implementation and external testing without needing to ask for clarification.',
    ],

    workflow: {
      capture: [
        'Read existing specs and repository instructions. Resolve the canonical spec before writing; use the configured path or unambiguous discovery, and ask only if competing authorities cannot be resolved.',
        'Record explicit user decisions in project description or relevant area prose and behavior fields, including decisions made in conversation without code changes. Project description and area prose explain outcome and purpose; behavior.title is a human label; behavior.description is the precise contract; behavior.rationale explains why and known tradeoffs. Add behavior.source.text with the exact wording and source.reference when available; never invent a source. Write rationale only from known intent and label assumptions clearly. Rationale is not test evidence or source quotation.',
        'Compare new intent with existing behavior and global constraints. An explicit authorized change updates the same behavior and preserves its ID; retain relevant rationale in details or Git history. Surface unresolved contradictions with both sources before dependent implementation. Continue independent work.',
        'Report which area/behavior IDs captured the decision, then lint the spec. Plans and existing task trackers reference those IDs; do not create a second requirements document or intent ledger.',
      ],
      review: [
        'Before implementation, read the canonical spec, applicable global constraints, requested change, and existing plan/tasks. Review relevant behaviors across areas; do not limit review to edited files. State scope and unavailable inputs.',
        'Check for conflicting requirements, ambiguous acceptance criteria, missing failure cases, tasks without a requirement, and requirements omitted from the plan. Distinguish explicit decisions from assumptions; resolve routine choices using existing authority.',
        'Keep this review read-only. For each finding give area/behavior ID (or unmapped), both relevant source locations, conflict or gap, severity, and concrete next action. Separate unresolved intent decisions from implementation work; route authorized corrections through capture or normal implementation.',
        'Report no findings only within the inspected scope. This is agent judgment, not deterministic semantic validation. Structural lint and spec check cannot establish agreement between prose, code, or tasks.',
      ],
      reconcile: [
        'After implementation, compare current code and actual execution evidence with every affected behavior, global constraint, and potentially regressed behavior. Inspect existing completed tasks too: a checked box is not evidence. State the reviewed revision and scope.',
        'Run relevant project smoke and regression tests through existing runners; tests should cite the behavior IDs they cover. For bug fixes rerun the original reproduction. Record exact command, outcome, environment, and revision in the existing PR or task tracker. If execution or coverage evidence is missing, mark affected behavior unverified. Specify does not automatically verify semantic agreement between prose, code, and tests.',
        'For each reviewed area/behavior ID report satisfied, gap, or unverified with code locations and supporting evidence. Identify missing, partial, contradictory, and unrequested implementation. A test-file name alone, an old passing run, or a suite unrelated to the claim cannot establish satisfaction.',
        'Run linked formal checks when relevant and report simulation, bounded verification, and proof separately from application evidence. A passing model does not prove the implementation matches it. An absent formal link means no formal evidence, not failed application verification; missing required application evidence means unverified.',
        'Never rewrite a requirement to match buggy or incomplete code. Keep the review itself read-only for code and intent; put corrective work in the existing issue tracker, then implement authorized fixes and repeat reconciliation. Ask only for new authority or unresolved intent, and report exact external blockers.',
        'Before handoff, run spec check against the task start or PR base with an honest unchanged-intent reason when needed. Report outstanding gaps and unverified behaviors; do not call the task complete while required checks fail or required verification is missing. Keep evidence in existing PR/task records, not another spec or report store.',
      ],
    },
  };
}
