/**
 * src/spec/gap-analyzer.ts — Analyze a spec for weaknesses and missing coverage.
 *
 * Returns a list of SpecGap objects, each describing a problem and providing
 * an interactive apply() to fix it via user prompts.
 */

import type { Spec } from './types.js';
import type { DiscoveredPage } from '../cli/interactive/crawler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptHelpers {
  ask: (question: string, defaultVal?: string) => Promise<string>;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  choose: (question: string, options: string[]) => Promise<number>;
}

export interface SpecGap {
  category: string;
  description: string;
  question: string;
  apply: (spec: Spec, helpers: PromptHelpers) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function analyzeSpecGaps(spec: Spec, discoveredPages?: DiscoveredPage[]): SpecGap[] {
  const gaps: SpecGap[] = [];

  // 1. Missing description
  if (!spec.description) {
    gaps.push({
      category: 'Metadata',
      description: 'Spec has no description. A description helps agents and team members understand what this spec covers.',
      question: 'Add a description?',
      apply: async (s, { ask }) => {
        const desc = await ask('Description for this spec');
        if (desc) s.description = desc;
      },
    });
  }

  // 2. No defaults
  if (!spec.defaults) {
    gaps.push({
      category: 'Default Properties',
      description: 'No default properties defined. Defaults like no_5xx and no_console_errors catch common issues across all pages.',
      question: 'Add default properties?',
      apply: async (s, { confirm }) => {
        s.defaults = {};
        if (await confirm('Block 5xx server errors on all pages?', true)) s.defaults.no_5xx = true;
        if (await confirm('Block console.error on all pages?', true)) s.defaults.no_console_errors = true;
        if (await confirm('Block uncaught exceptions on all pages?', true)) s.defaults.no_uncaught_exceptions = true;
      },
    });
  } else {
    // Partial defaults
    const missing: string[] = [];
    if (spec.defaults.no_5xx === undefined) missing.push('no_5xx');
    if (spec.defaults.no_console_errors === undefined) missing.push('no_console_errors');
    if (spec.defaults.no_uncaught_exceptions === undefined) missing.push('no_uncaught_exceptions');
    if (missing.length > 0) {
      gaps.push({
        category: 'Default Properties',
        description: `Missing default checks: ${missing.join(', ')}. These catch common issues.`,
        question: 'Add missing defaults?',
        apply: async (s, { confirm }) => {
          s.defaults = s.defaults ?? {};
          for (const m of missing) {
            if (await confirm(`  Enable ${m}?`, true)) {
              (s.defaults as Record<string, boolean>)[m] = true;
            }
          }
        },
      });
    }
  }

  // 3. No assumptions
  if (!spec.assumptions || spec.assumptions.length === 0) {
    gaps.push({
      category: 'Assumptions',
      description: 'No assumptions (preconditions) defined. Assumptions prevent false failures when the target is down or misconfigured.',
      question: 'Add assumptions?',
      apply: async (s, { ask, confirm }) => {
        s.assumptions = [];
        const url = await ask('URL that must be reachable before testing (e.g. http://localhost:3000)', '');
        if (url) {
          s.assumptions.push({ type: 'url_reachable', url, description: `${url} must be reachable` });
        }
        let addMore = url ? await confirm('Add another assumption?', false) : false;
        while (addMore) {
          const envVar = await ask('Required environment variable (empty to stop)', '');
          if (envVar) {
            s.assumptions.push({ type: 'env_var_set', name: envVar, description: `${envVar} must be set` });
          } else break;
          addMore = await confirm('Add another?', false);
        }
      },
    });
  }

  // 4. No pages
  if (!spec.pages || spec.pages.length === 0) {
    gaps.push({
      category: 'Pages',
      description: 'No pages defined. Pages are the core of the spec — each one describes a verifiable view.',
      question: 'Add pages?',
      apply: async (s, { ask, confirm }) => {
        s.pages = [];
        let adding = true;
        while (adding) {
          const pagePath = await ask('Page path (e.g. /dashboard)');
          if (!pagePath) break;
          const id = pagePath.replace(/^\//, '').replace(/[\/\?&#=.]/g, '-').replace(/-+/g, '-') || 'root';
          const title = await ask('Expected page title (optional)', '');
          s.pages.push({ id, path: pagePath, ...(title ? { title } : {}) });
          adding = await confirm('Add another page?', true);
        }
      },
    });
  }

  // 5. Discovered pages not in spec
  if (discoveredPages && discoveredPages.length > 0 && spec.pages) {
    const existingPaths = new Set(spec.pages.map(p => p.path));
    const missingPages = discoveredPages.filter(d => !existingPaths.has(d.path));
    if (missingPages.length > 0) {
      gaps.push({
        category: 'Missing Pages (from crawl)',
        description: `Found ${missingPages.length} page(s) on the website not covered by the spec: ${missingPages.map(p => p.path).join(', ')}`,
        question: 'Review and add missing pages?',
        apply: async (s, { confirm }) => {
          s.pages = s.pages ?? [];
          for (const page of missingPages) {
            const label = page.title ? `${page.path} ("${page.title}")` : page.path;
            if (await confirm(`Add ${label}?`, true)) {
              const id = page.path.replace(/^\//, '').replace(/[\/\?&#=.]/g, '-').replace(/-+/g, '-') || 'root';
              s.pages.push({
                id,
                path: page.path,
                ...(page.title ? { title: page.title } : {}),
              });
            }
          }
        },
      });
    }
  }

  // 6. Pages without visual assertions
  const pagesWithoutAssertions = (spec.pages ?? []).filter(
    p => !p.visual_assertions || p.visual_assertions.length === 0,
  );
  if (pagesWithoutAssertions.length > 0) {
    gaps.push({
      category: 'Visual Assertions',
      description: `${pagesWithoutAssertions.length} page(s) have no visual assertions: ${pagesWithoutAssertions.map(p => p.id).join(', ')}. Visual assertions verify what the user should see.`,
      question: 'Add visual assertions to these pages?',
      apply: async (_s, { ask, confirm, choose }) => {
        for (const page of pagesWithoutAssertions) {
          console.error(`\n    Page: ${page.id} (${page.path})`);
          if (!await confirm(`    Add visual assertions for ${page.id}?`, true)) continue;

          page.visual_assertions = [];
          let adding = true;
          while (adding) {
            const types = ['element_exists', 'text_contains', 'text_matches', 'element_count'];
            const idx = await choose('    Assertion type?', types);
            const type = types[idx];
            const selector = await ask('    CSS selector');
            if (!selector) break;
            const description = await ask('    Description (optional)', '');

            if (type === 'element_exists') {
              page.visual_assertions.push({ type: 'element_exists', selector, ...(description ? { description } : {}) });
            } else if (type === 'text_contains') {
              const text = await ask('    Expected text');
              page.visual_assertions.push({ type: 'text_contains', selector, text, ...(description ? { description } : {}) });
            } else if (type === 'text_matches') {
              const pattern = await ask('    Regex pattern');
              page.visual_assertions.push({ type: 'text_matches', selector, pattern, ...(description ? { description } : {}) });
            } else if (type === 'element_count') {
              const min = await ask('    Minimum count (empty for none)', '');
              const max = await ask('    Maximum count (empty for none)', '');
              page.visual_assertions.push({
                type: 'element_count',
                selector,
                ...(min ? { min: parseInt(min, 10) } : {}),
                ...(max ? { max: parseInt(max, 10) } : {}),
                ...(description ? { description } : {}),
              });
            }
            adding = await confirm('    Add another assertion?', false);
          }
        }
      },
    });
  }

  // 7. Pages without titles
  const pagesWithoutTitles = (spec.pages ?? []).filter(p => !p.title);
  if (pagesWithoutTitles.length > 0 && pagesWithoutTitles.length < (spec.pages?.length ?? 0)) {
    gaps.push({
      category: 'Page Titles',
      description: `${pagesWithoutTitles.length} page(s) missing title assertions: ${pagesWithoutTitles.map(p => p.id).join(', ')}`,
      question: 'Add titles to these pages?',
      apply: async (_s, { ask }) => {
        for (const page of pagesWithoutTitles) {
          const title = await ask(`    Title for ${page.id} (${page.path})`, '');
          if (title) page.title = title;
        }
      },
    });
  }

  // 8. Pages without scenarios
  const pagesWithoutScenarios = (spec.pages ?? []).filter(
    p => !p.scenarios || p.scenarios.length === 0,
  );
  if (pagesWithoutScenarios.length > 0) {
    gaps.push({
      category: 'Scenarios',
      description: `${pagesWithoutScenarios.length} page(s) have no interactive scenarios: ${pagesWithoutScenarios.map(p => p.id).join(', ')}. Scenarios test user interactions like form submissions and navigation.`,
      question: 'Add scenarios to any of these pages?',
      apply: async (_s, { ask, confirm, choose }) => {
        for (const page of pagesWithoutScenarios) {
          if (!await confirm(`    Add a scenario to ${page.id}?`, false)) continue;

          page.scenarios = page.scenarios ?? [];
          const id = await ask('    Scenario ID (e.g. submit-form)');
          if (!id) continue;
          const description = await ask('    Description', '');
          const scenario = { id, steps: [] as any[], ...(description ? { description } : {}) };

          let addingSteps = true;
          while (addingSteps) {
            const actions = ['click', 'fill', 'assert_visible', 'assert_text', 'wait_for_navigation', 'hover', 'keypress', 'wait'];
            const idx = await choose('    Step action?', actions);
            const action = actions[idx];

            if (['click', 'hover', 'assert_visible'].includes(action)) {
              const selector = await ask('    CSS selector');
              if (selector) scenario.steps.push({ action, selector });
            } else if (action === 'fill') {
              const selector = await ask('    CSS selector');
              const value = await ask('    Value');
              if (selector) scenario.steps.push({ action: 'fill', selector, value });
            } else if (action === 'assert_text') {
              const selector = await ask('    CSS selector');
              const text = await ask('    Expected text');
              if (selector) scenario.steps.push({ action: 'assert_text', selector, text });
            } else if (action === 'wait_for_navigation') {
              const urlPattern = await ask('    URL pattern');
              if (urlPattern) scenario.steps.push({ action: 'wait_for_navigation', url_pattern: urlPattern });
            } else if (action === 'keypress') {
              const key = await ask('    Key (e.g. Enter)');
              if (key) scenario.steps.push({ action: 'keypress', key });
            } else if (action === 'wait') {
              const dur = await ask('    Duration (ms)', '1000');
              scenario.steps.push({ action: 'wait', duration: parseInt(dur, 10) || 1000 });
            }

            addingSteps = await confirm('    Add another step?', true);
          }

          page.scenarios.push(scenario);
        }
      },
    });
  }

  // 9. Multiple pages but no flows
  if ((spec.pages?.length ?? 0) >= 2 && (!spec.flows || spec.flows.length === 0)) {
    gaps.push({
      category: 'Flows',
      description: 'Multiple pages exist but no flows defined. Flows test multi-page user journeys (e.g. login \u2192 dashboard).',
      question: 'Create a flow?',
      apply: async (s, { ask }) => {
        s.flows = s.flows ?? [];
        const id = await ask('Flow ID (e.g. login-to-dashboard)');
        if (!id) return;
        const description = await ask('Description', '');

        const pages = s.pages ?? [];
        console.error('    Available pages:');
        for (const p of pages) {
          console.error(`      - ${p.id} (${p.path})`);
        }

        const stepsStr = await ask('Page IDs in order, comma-separated');
        const pageIds = stepsStr.split(',').map(x => x.trim()).filter(Boolean);

        const steps = pageIds.flatMap(pageId => {
          const page = pages.find(p => p.id === pageId);
          if (!page) return [];
          return [
            { navigate: page.path, description: `Go to ${page.path}` },
            { assert_page: pageId, description: `Verify ${pageId}` },
          ];
        });

        s.flows.push({ id, ...(description ? { description } : {}), steps });
      },
    });
  }

  // 10. No variables
  if (!spec.variables || Object.keys(spec.variables).length === 0) {
    gaps.push({
      category: 'Variables',
      description: 'No template variables defined. Variables (like base_url, test credentials) make specs portable across environments.',
      question: 'Add template variables?',
      apply: async (s, { ask, confirm }) => {
        s.variables = {};
        let adding = true;
        while (adding) {
          const name = await ask('Variable name (e.g. base_url)');
          if (!name) break;
          const value = await ask(`Value for {{${name}}}`);
          s.variables[name] = value;
          adding = await confirm('Add another variable?', false);
        }
      },
    });
  }

  return gaps;
}
