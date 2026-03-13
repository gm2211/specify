/**
 * src/spec/evolve.ts — Spec evolution engine
 *
 * Two modes:
 *   1. PR-based: analyze a PR diff to suggest spec changes
 *   2. Interactive: analyze spec gaps for an LLM agent with askUser
 *
 * Both modes produce structured suggestions designed for LLM callers
 * to act on — not auto-applied.
 */

import type {
  Spec,
  PageSpec,
  CliSpec,
  CliCommandSpec,
  ScenarioSpec,
  FlowSpec,
  VisualAssertion,
} from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvolveSuggestion {
  /** Unique id for this suggestion. */
  id: string;

  /** Category of the suggestion. */
  category:
    | 'new_coverage'
    | 'update_coverage'
    | 'remove_stale'
    | 'add_scenario'
    | 'add_assertion'
    | 'add_flow'
    | 'add_error_path'
    | 'add_cli_command'
    | 'spec_hygiene';

  /** Priority: high = likely needed, medium = worth considering, low = nice-to-have. */
  priority: 'high' | 'medium' | 'low';

  /** Short description of what to change. */
  description: string;

  /** Why this change is suggested — context for the LLM agent. */
  rationale: string;

  /** The proposed spec change. */
  proposed_change: ProposedChange;

  /**
   * Question for the agent to ask the user (via askUser).
   * Phrased as a yes/no or short-answer question.
   */
  question: string;
}

export type ProposedChange =
  | { action: 'add_page'; fragment: Partial<PageSpec> }
  | { action: 'update_page'; page_id: string; changes: Partial<PageSpec> }
  | { action: 'remove_page'; page_id: string }
  | { action: 'add_scenario'; page_id: string; fragment: Partial<ScenarioSpec> }
  | { action: 'add_flow'; fragment: Partial<FlowSpec> }
  | { action: 'add_visual_assertion'; page_id: string; assertions: Partial<VisualAssertion>[] }
  | { action: 'add_cli_command'; fragment: Partial<CliCommandSpec> }
  | { action: 'update_cli_command'; command_id: string; changes: Partial<CliCommandSpec> }
  | { action: 'add_cli_scenario'; fragment: { id: string; description: string; steps: Partial<CliCommandSpec>[] } }
  | { action: 'set_defaults'; defaults: Record<string, unknown> }
  | { action: 'add_assumption'; fragment: Record<string, unknown> }
  | { action: 'custom'; description: string; spec_fragment: unknown };

export interface EvolveResult {
  mode: 'pr' | 'interactive';
  spec_summary: SpecSummary;
  suggestions: EvolveSuggestion[];
  pr_context?: PrContext;
}

export interface SpecSummary {
  name: string;
  page_count: number;
  flow_count: number;
  scenario_count: number;
  cli_command_count: number;
  cli_scenario_count: number;
  has_defaults: boolean;
  has_assumptions: boolean;
  has_hooks: boolean;
}

export interface PrContext {
  pr_number: number;
  title: string;
  body: string;
  changed_files: ChangedFile[];
  additions: number;
  deletions: number;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

// ---------------------------------------------------------------------------
// Spec summary
// ---------------------------------------------------------------------------

export function summarizeSpec(spec: Spec): SpecSummary {
  const scenarioCount = (spec.pages ?? []).reduce(
    (n, p) => n + (p.scenarios?.length ?? 0),
    0,
  );
  return {
    name: spec.name,
    page_count: spec.pages?.length ?? 0,
    flow_count: spec.flows?.length ?? 0,
    scenario_count: scenarioCount,
    cli_command_count: spec.cli?.commands?.length ?? 0,
    cli_scenario_count: spec.cli?.scenarios?.length ?? 0,
    has_defaults: !!spec.defaults,
    has_assumptions: (spec.assumptions?.length ?? 0) > 0,
    has_hooks: !!spec.hooks,
  };
}

// ---------------------------------------------------------------------------
// PR-based evolution
// ---------------------------------------------------------------------------

export function analyzePr(spec: Spec, pr: PrContext): EvolveSuggestion[] {
  const suggestions: EvolveSuggestion[] = [];
  let nextId = 1;
  const sid = () => `pr-${nextId++}`;

  const specPagePaths = new Set((spec.pages ?? []).map(p => p.path));
  const specCliIds = new Set((spec.cli?.commands ?? []).map(c => c.id));

  // Classify changed files
  const classified = classifyChangedFiles(pr.changed_files);

  // 1. New routes/pages
  for (const route of classified.newRoutes) {
    if (!specPagePaths.has(route.path)) {
      suggestions.push({
        id: sid(),
        category: 'new_coverage',
        priority: 'high',
        description: `New route "${route.path}" has no spec coverage`,
        rationale: `File "${route.file}" was added/modified in the PR and appears to define a new route at "${route.path}". The current spec has no page for this path.`,
        proposed_change: {
          action: 'add_page',
          fragment: {
            id: pathToId(route.path),
            path: route.path,
          },
        },
        question: `The PR adds a new route at "${route.path}" (from ${route.file}). Should we add spec coverage for this page?`,
      });
    }
  }

  // 2. Modified routes — may need spec updates
  for (const route of classified.modifiedRoutes) {
    if (specPagePaths.has(route.path)) {
      suggestions.push({
        id: sid(),
        category: 'update_coverage',
        priority: 'medium',
        description: `Route "${route.path}" was modified — spec may need updating`,
        rationale: `File "${route.file}" was modified in the PR. The spec has an existing page for "${route.path}" but the implementation may have changed.`,
        proposed_change: {
          action: 'update_page',
          page_id: pathToId(route.path),
          changes: {},
        },
        question: `The PR modifies the "${route.path}" route (in ${route.file}). Do the existing spec assertions still match the new behavior?`,
      });
    }
  }

  // 3. New API endpoints
  for (const endpoint of classified.newEndpoints) {
    suggestions.push({
      id: sid(),
      category: 'new_coverage',
      priority: 'high',
      description: `New API endpoint "${endpoint.method} ${endpoint.path}"`,
      rationale: `File "${endpoint.file}" introduces a new API handler for ${endpoint.method} ${endpoint.path}. Consider adding expected_requests to the relevant page spec.`,
      proposed_change: {
        action: 'custom',
        description: `Add expected_request for ${endpoint.method} ${endpoint.path}`,
        spec_fragment: {
          method: endpoint.method,
          url_pattern: endpoint.path,
          confidence: 'inferred',
        },
      },
      question: `The PR adds a new API endpoint "${endpoint.method} ${endpoint.path}" (in ${endpoint.file}). Which page should expect this request, and what response shape should we assert?`,
    });
  }

  // 4. New CLI commands/subcommands
  for (const cmd of classified.newCliCommands) {
    if (!specCliIds.has(cmd.id)) {
      suggestions.push({
        id: sid(),
        category: 'add_cli_command',
        priority: 'high',
        description: `New CLI command "${cmd.id}" has no spec coverage`,
        rationale: `The PR appears to add a new CLI command or subcommand "${cmd.id}" in "${cmd.file}".`,
        proposed_change: {
          action: 'add_cli_command',
          fragment: {
            id: cmd.id,
            args: cmd.args ?? [],
            description: `Verify ${cmd.id} command`,
          },
        },
        question: `The PR adds a new CLI command "${cmd.id}". What exit code and output should we expect?`,
      });
    }
  }

  // 5. Removed files — potential stale spec items
  for (const file of classified.removedFiles) {
    const relatedPages = (spec.pages ?? []).filter(p => {
      const pagePath = p.path.replace(/^\//, '');
      return file.includes(pagePath) || pagePath.includes(fileToSegment(file));
    });
    for (const page of relatedPages) {
      suggestions.push({
        id: sid(),
        category: 'remove_stale',
        priority: 'medium',
        description: `File "${file}" was removed — page "${page.id}" may be stale`,
        rationale: `The file "${file}" was deleted in this PR and may be related to the spec page "${page.id}" (path: "${page.path}").`,
        proposed_change: {
          action: 'remove_page',
          page_id: page.id,
        },
        question: `The file "${file}" was removed in this PR. Is the spec page "${page.id}" (${page.path}) still valid, or should it be removed?`,
      });
    }
  }

  // 6. PR title/body analysis for intent signals
  const prText = `${pr.title}\n${pr.body}`.toLowerCase();
  if (prText.includes('breaking change') || prText.includes('breaking:')) {
    suggestions.push({
      id: sid(),
      category: 'update_coverage',
      priority: 'high',
      description: 'PR indicates breaking changes — spec review needed',
      rationale: `The PR title or description mentions "breaking change". The spec should be reviewed to ensure all assertions still match the new behavior.`,
      proposed_change: {
        action: 'custom',
        description: 'Review all spec assertions for breaking changes',
        spec_fragment: null,
      },
      question: 'This PR mentions breaking changes. Which spec assertions need to be updated to match the new behavior?',
    });
  }

  if (prText.includes('deprecat')) {
    suggestions.push({
      id: sid(),
      category: 'remove_stale',
      priority: 'medium',
      description: 'PR mentions deprecation — review for stale assertions',
      rationale: 'The PR mentions deprecation. Some spec assertions may reference deprecated features that will eventually be removed.',
      proposed_change: {
        action: 'custom',
        description: 'Identify and update assertions on deprecated features',
        spec_fragment: null,
      },
      question: 'This PR deprecates some features. Are there spec assertions that reference deprecated behavior and should be updated?',
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Interactive evolution (for LLM agent with askUser)
// ---------------------------------------------------------------------------

export function analyzeInteractive(spec: Spec): EvolveSuggestion[] {
  const suggestions: EvolveSuggestion[] = [];
  let nextId = 1;
  const sid = () => `int-${nextId++}`;

  // 1. Missing description
  if (!spec.description) {
    suggestions.push({
      id: sid(),
      category: 'spec_hygiene',
      priority: 'low',
      description: 'Spec has no description',
      rationale: 'A description helps both humans and LLM agents understand the scope and intent of the spec.',
      proposed_change: {
        action: 'custom',
        description: 'Add a description field to the spec',
        spec_fragment: { description: '' },
      },
      question: 'What does this spec cover? Please describe the application or CLI being tested.',
    });
  }

  // 2. Missing defaults
  if (!spec.defaults) {
    suggestions.push({
      id: sid(),
      category: 'spec_hygiene',
      priority: 'medium',
      description: 'No default properties set',
      rationale: 'Default properties like no_5xx, no_console_errors provide baseline coverage across all pages without per-page configuration.',
      proposed_change: {
        action: 'set_defaults',
        defaults: {
          no_5xx: true,
          no_console_errors: true,
          no_uncaught_exceptions: true,
        },
      },
      question: 'Should we enable default checks across all pages? (no 5xx responses, no console errors, no uncaught exceptions)',
    });
  }

  // 3. Missing assumptions
  if (!spec.assumptions?.length && (spec.pages?.length ?? 0) > 0) {
    const baseUrl = spec.variables?.base_url;
    suggestions.push({
      id: sid(),
      category: 'spec_hygiene',
      priority: 'medium',
      description: 'No assumptions (preconditions) defined',
      rationale: 'Assumptions ensure the spec is only validated when the target is actually reachable, preventing false failures.',
      proposed_change: {
        action: 'add_assumption',
        fragment: baseUrl
          ? { type: 'url_reachable', url: baseUrl, description: 'Target application is running' }
          : { type: 'env_var_set', name: 'TARGET_URL', description: 'Target URL is configured' },
      },
      question: 'What preconditions should hold before running this spec? (e.g., is the target URL reachable, are required env vars set?)',
    });
  }

  // 4. Pages without visual assertions
  for (const page of spec.pages ?? []) {
    if (!page.visual_assertions?.length) {
      suggestions.push({
        id: sid(),
        category: 'add_assertion',
        priority: 'medium',
        description: `Page "${page.id}" has no visual assertions`,
        rationale: `Page "${page.id}" (path: "${page.path}") loads content but has no assertions checking what appears on screen. This means UI regressions won't be caught.`,
        proposed_change: {
          action: 'add_visual_assertion',
          page_id: page.id,
          assertions: [
            { type: 'element_exists', selector: '' },
          ],
        },
        question: `What elements should be visible on the "${page.id}" page (${page.path})? For example, a heading, a form, a navigation bar?`,
      });
    }
  }

  // 5. Pages without scenarios
  for (const page of spec.pages ?? []) {
    if (!page.scenarios?.length) {
      suggestions.push({
        id: sid(),
        category: 'add_scenario',
        priority: 'medium',
        description: `Page "${page.id}" has no interactive scenarios`,
        rationale: `Page "${page.id}" has visual assertions but no scenarios testing user interactions (clicks, form fills, etc). Interactive flows are the most common source of bugs.`,
        proposed_change: {
          action: 'add_scenario',
          page_id: page.id,
          fragment: {
            id: `${page.id}-interaction`,
            description: `User interaction on ${page.id}`,
            steps: [],
          },
        },
        question: `What user interactions happen on the "${page.id}" page? (e.g., clicking buttons, filling forms, filtering data)`,
      });
    }
  }

  // 6. Pages without expected_requests
  for (const page of spec.pages ?? []) {
    if (!page.expected_requests?.length) {
      suggestions.push({
        id: sid(),
        category: 'add_assertion',
        priority: 'low',
        description: `Page "${page.id}" has no expected API requests`,
        rationale: `Page "${page.id}" has no expected_requests. If this page loads data from APIs, adding request assertions helps catch backend regressions.`,
        proposed_change: {
          action: 'update_page',
          page_id: page.id,
          changes: {
            expected_requests: [],
          },
        },
        question: `Does the "${page.id}" page (${page.path}) make any API calls when it loads? If so, what endpoints?`,
      });
    }
  }

  // 7. Missing flows (2+ pages, no flows)
  if ((spec.pages?.length ?? 0) >= 2 && !spec.flows?.length) {
    const pageIds = (spec.pages ?? []).map(p => p.id);
    suggestions.push({
      id: sid(),
      category: 'add_flow',
      priority: 'medium',
      description: 'No multi-page flows defined',
      rationale: `The spec has ${pageIds.length} pages but no flows connecting them. Flows verify that navigating between pages works correctly (e.g., login → dashboard).`,
      proposed_change: {
        action: 'add_flow',
        fragment: {
          id: 'main-flow',
          description: 'Primary user journey',
          steps: [],
        },
      },
      question: `What's the main user journey across your pages? For example, do users go from ${pageIds.slice(0, 3).join(' → ')}?`,
    });
  }

  // 8. Error path coverage
  for (const page of spec.pages ?? []) {
    const hasErrorScenarios = (page.scenarios ?? []).some(s =>
      s.id.includes('error') || s.id.includes('fail') || s.id.includes('invalid') ||
      (s.description ?? '').toLowerCase().includes('error') ||
      (s.description ?? '').toLowerCase().includes('invalid')
    );
    if (!hasErrorScenarios && (page.scenarios?.length ?? 0) > 0) {
      suggestions.push({
        id: sid(),
        category: 'add_error_path',
        priority: 'medium',
        description: `Page "${page.id}" has no error/failure scenarios`,
        rationale: `Page "${page.id}" has ${page.scenarios!.length} scenario(s) but none test error conditions (invalid input, network failures, permission errors). Error paths are often undertested.`,
        proposed_change: {
          action: 'add_scenario',
          page_id: page.id,
          fragment: {
            id: `${page.id}-error`,
            description: `Error handling on ${page.id}`,
            steps: [],
          },
        },
        question: `What happens on the "${page.id}" page when something goes wrong? (e.g., submitting invalid data, permission denied, server error)`,
      });
    }
  }

  // 9. CLI commands without output assertions
  for (const cmd of spec.cli?.commands ?? []) {
    if (!cmd.stdout_assertions?.length && !cmd.stderr_assertions?.length) {
      suggestions.push({
        id: sid(),
        category: 'add_assertion',
        priority: 'medium',
        description: `CLI command "${cmd.id}" has no output assertions`,
        rationale: `Command "${cmd.id}" (args: ${cmd.args.join(' ')}) checks exit code but has no assertions on stdout or stderr. Output content changes would go undetected.`,
        proposed_change: {
          action: 'update_cli_command',
          command_id: cmd.id,
          changes: {
            stdout_assertions: [],
          },
        },
        question: `What should the "${cmd.id}" command (${cmd.args.join(' ')}) output? Should we check for specific text, JSON structure, or other patterns?`,
      });
    }
  }

  // 10. CLI error paths
  if (spec.cli?.commands?.length) {
    const hasErrorCommands = spec.cli.commands.some(c =>
      (c.expected_exit_code !== undefined && c.expected_exit_code !== 0) ||
      (c.expected_exit_codes?.some(code => code !== 0))
    );
    if (!hasErrorCommands) {
      suggestions.push({
        id: sid(),
        category: 'add_error_path',
        priority: 'medium',
        description: 'No CLI error path coverage',
        rationale: 'All CLI commands in the spec expect exit code 0. Testing error paths (bad arguments, missing files, invalid input) ensures the CLI fails gracefully.',
        proposed_change: {
          action: 'add_cli_command',
          fragment: {
            id: 'error-handling',
            args: [],
            description: 'Verify error handling',
            expected_exit_code: 1,
          },
        },
        question: 'What happens when the CLI receives invalid input? What error exit codes and messages should it produce?',
      });
    }
  }

  // 11. Scenarios without assertion steps
  for (const page of spec.pages ?? []) {
    for (const scenario of page.scenarios ?? []) {
      const hasAssertions = scenario.steps.some(s =>
        s.action === 'assert_visible' || s.action === 'assert_text' || s.action === 'assert_not_visible'
      );
      if (!hasAssertions && scenario.steps.length > 0) {
        suggestions.push({
          id: sid(),
          category: 'add_assertion',
          priority: 'medium',
          description: `Scenario "${scenario.id}" has interactions but no assertions`,
          rationale: `Scenario "${scenario.id}" on page "${page.id}" performs actions (${scenario.steps.map(s => s.action).join(', ')}) but never checks the result. Without assertions, it only verifies the page doesn't crash.`,
          proposed_change: {
            action: 'custom',
            description: `Add assert_visible or assert_text steps to scenario "${scenario.id}"`,
            spec_fragment: { page_id: page.id, scenario_id: scenario.id },
          },
          question: `After performing the "${scenario.id}" scenario on "${page.id}", what should be visible on the page? What text or elements confirm success?`,
        });
      }
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// PR diff classification
// ---------------------------------------------------------------------------

interface ClassifiedChanges {
  newRoutes: { path: string; file: string }[];
  modifiedRoutes: { path: string; file: string }[];
  newEndpoints: { method: string; path: string; file: string }[];
  newCliCommands: { id: string; args?: string[]; file: string }[];
  removedFiles: string[];
}

function classifyChangedFiles(files: ChangedFile[]): ClassifiedChanges {
  const result: ClassifiedChanges = {
    newRoutes: [],
    modifiedRoutes: [],
    newEndpoints: [],
    newCliCommands: [],
    removedFiles: [],
  };

  for (const file of files) {
    if (file.status === 'removed') {
      result.removedFiles.push(file.filename);
      continue;
    }

    const patch = file.patch ?? '';

    // Detect route patterns in web frameworks
    const routePatterns = extractRoutePatterns(patch, file.filename);
    for (const route of routePatterns) {
      if (file.status === 'added') {
        result.newRoutes.push({ path: route, file: file.filename });
      } else {
        result.modifiedRoutes.push({ path: route, file: file.filename });
      }
    }

    // Detect API endpoint patterns
    const endpoints = extractEndpointPatterns(patch, file.filename);
    for (const ep of endpoints) {
      result.newEndpoints.push({ ...ep, file: file.filename });
    }

    // Detect CLI command patterns
    const commands = extractCliCommandPatterns(patch, file.filename);
    for (const cmd of commands) {
      result.newCliCommands.push({ ...cmd, file: file.filename });
    }
  }

  return result;
}

/** Extract route paths from added lines in a patch. */
function extractRoutePatterns(patch: string, filename: string): string[] {
  const routes: string[] = [];
  const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  for (const line of addedLines) {
    // Next.js/file-based: pages/foo/bar.tsx → /foo/bar
    if (filename.match(/(?:pages|app)\/.*\.(tsx?|jsx?)$/)) {
      const routePath = filename
        .replace(/^.*(?:pages|app)/, '')
        .replace(/\.(tsx?|jsx?)$/, '')
        .replace(/\/index$/, '')
        .replace(/\[([^\]]+)\]/g, ':$1');
      if (routePath && !routes.includes(routePath)) {
        routes.push(routePath || '/');
      }
    }

    // Express/Koa/Hono: app.get('/path', ...) or router.post('/path', ...)
    const expressMatch = line.match(/\.(?:get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"` ]+)['"`]/);
    if (expressMatch) {
      routes.push(expressMatch[1]);
    }

    // React Router: <Route path="/foo" ...> or path: '/foo'
    const routerMatch = line.match(/path[=:]\s*['"`]([^'"` ]+)['"`]/);
    if (routerMatch && routerMatch[1].startsWith('/')) {
      routes.push(routerMatch[1]);
    }
  }

  return [...new Set(routes)];
}

/** Extract API endpoint patterns from added lines. */
function extractEndpointPatterns(patch: string, _filename: string): { method: string; path: string }[] {
  const endpoints: { method: string; path: string }[] = [];
  const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  for (const line of addedLines) {
    // Express/Koa: router.get('/api/foo', ...)
    const match = line.match(/\.(?:get|post|put|patch|delete)\s*\(\s*['"`](\/api\/[^'"` ]+)['"`]/);
    if (match) {
      const method = line.match(/\.(get|post|put|patch|delete)\s*\(/)![1].toUpperCase();
      endpoints.push({ method, path: match[1] });
    }
  }

  return endpoints;
}

/** Extract CLI command patterns from added lines. */
function extractCliCommandPatterns(patch: string, filename: string): { id: string; args?: string[] }[] {
  const commands: { id: string; args?: string[] }[] = [];
  const addedLines = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  for (const line of addedLines) {
    // Command manifest entries: name: 'noun verb'
    const nameMatch = line.match(/name:\s*['"`]([^'"` ]+(?:\s+[^'"` ]+)?)['"`]/);
    if (nameMatch && filename.includes('command') && filename.includes('manifest')) {
      const parts = nameMatch[1].split(/\s+/);
      commands.push({ id: nameMatch[1].replace(/\s+/g, '-'), args: parts });
    }

    // Yargs/commander: .command('name', ...)
    const cmdMatch = line.match(/\.command\s*\(\s*['"`]([^'"` ]+)['"`]/);
    if (cmdMatch) {
      commands.push({ id: cmdMatch[1] });
    }
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathToId(p: string): string {
  return p.replace(/^\//, '').replace(/[\/\?&#=.:]/g, '-').replace(/-+/g, '-') || 'root';
}

function fileToSegment(filepath: string): string {
  const base = filepath.split('/').pop() ?? '';
  return base.replace(/\.(tsx?|jsx?|vue|svelte)$/, '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
}
