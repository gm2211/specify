/**
 * src/e2e/sync-engine.ts — Bidirectional comparison engine
 *
 * Compares spec items against analyzed test files to produce a
 * SyncReport showing coverage gaps, unmapped tests, and mismatches.
 */

import type { Spec, PageSpec, ScenarioSpec, ScenarioStep, FlowSpec } from '../spec/types.js';
import { isV1 } from '../spec/types.js';
import type {
  TestFileAnalysis,
  TestCase,
  SyncReport,
  UncoveredSpecItem,
  UnmappedTest,
  SyncMismatch,
  MatchedPair,
  SyncSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compute a sync report comparing a spec against analyzed test files. */
export function computeSync(spec: Spec, testAnalyses: TestFileAnalysis[]): SyncReport {
  if (!isV1(spec)) {
    // v2 specs don't have pages/flows — return empty sync report
    const allTests = flattenTests(testAnalyses);
    return {
      uncoveredSpecItems: [],
      unmappedTests: allTests.map(({ test, filePath }) => ({
        testName: test.name,
        filePath,
        analysis: test,
      })),
      mismatches: [],
      matched: [],
      summary: {
        totalSpecItems: 0,
        totalTests: allTests.length,
        matched: 0,
        uncoveredSpecItems: 0,
        unmappedTests: allTests.length,
        mismatches: 0,
        syncPercentage: 100,
      },
    };
  }
  // Flatten all test cases across files
  const allTests = flattenTests(testAnalyses);

  const uncoveredSpecItems: UncoveredSpecItem[] = [];
  const mismatches: SyncMismatch[] = [];
  const matched: MatchedPair[] = [];
  const matchedTestKeys = new Set<string>();

  // Match pages
  for (const page of spec.pages ?? []) {
    const match = findPageMatch(page, allTests);
    if (!match) {
      uncoveredSpecItems.push({
        type: 'page',
        specId: page.id,
        context: page.path,
        specFragment: page,
      });
    } else {
      matched.push({
        specId: page.id,
        testName: match.test.name,
        filePath: match.filePath,
      });
      matchedTestKeys.add(testKey(match.filePath, match.test.name));

      // Check for assertion mismatches
      const diffs = comparePageAssertions(page, match.test);
      if (diffs.length > 0) {
        mismatches.push({
          specId: page.id,
          testName: match.test.name,
          differences: diffs,
        });
      }
    }

    // Match scenarios within the page
    for (const scenario of page.scenarios ?? []) {
      const scenarioMatch = findScenarioMatch(scenario, page, allTests);
      if (!scenarioMatch) {
        uncoveredSpecItems.push({
          type: 'scenario',
          specId: `${page.id}/${scenario.id}`,
          context: scenario.description ?? scenario.id,
          specFragment: scenario,
        });
      } else {
        matched.push({
          specId: `${page.id}/${scenario.id}`,
          testName: scenarioMatch.test.name,
          filePath: scenarioMatch.filePath,
        });
        matchedTestKeys.add(testKey(scenarioMatch.filePath, scenarioMatch.test.name));
      }
    }
  }

  // Match flows
  for (const flow of spec.flows ?? []) {
    const match = findFlowMatch(flow, allTests);
    if (!match) {
      uncoveredSpecItems.push({
        type: 'flow',
        specId: flow.id,
        context: flow.description ?? flow.id,
        specFragment: flow,
      });
    } else {
      matched.push({
        specId: flow.id,
        testName: match.test.name,
        filePath: match.filePath,
      });
      matchedTestKeys.add(testKey(match.filePath, match.test.name));
    }
  }

  // Find unmapped tests
  const unmappedTests: UnmappedTest[] = [];
  for (const { test, filePath } of allTests) {
    if (!matchedTestKeys.has(testKey(filePath, test.name))) {
      unmappedTests.push({
        testName: test.name,
        filePath,
        analysis: test,
      });
    }
  }

  // Count total spec items
  const totalSpecItems =
    (spec.pages?.length ?? 0) +
    (spec.pages?.reduce((n, p) => n + (p.scenarios?.length ?? 0), 0) ?? 0) +
    (spec.flows?.length ?? 0);

  const summary: SyncSummary = {
    totalSpecItems,
    totalTests: allTests.length,
    matched: matched.length,
    uncoveredSpecItems: uncoveredSpecItems.length,
    unmappedTests: unmappedTests.length,
    mismatches: mismatches.length,
    syncPercentage: totalSpecItems > 0
      ? Math.round((matched.length / totalSpecItems) * 100)
      : 100,
  };

  return { uncoveredSpecItems, unmappedTests, mismatches, matched, summary };
}

// ---------------------------------------------------------------------------
// Matching logic
// ---------------------------------------------------------------------------

interface FlatTest {
  test: TestCase;
  filePath: string;
}

function flattenTests(analyses: TestFileAnalysis[]): FlatTest[] {
  const result: FlatTest[] = [];
  for (const analysis of analyses) {
    for (const suite of analysis.suites) {
      for (const test of suite.tests) {
        result.push({ test, filePath: analysis.filePath });
      }
    }
    for (const test of analysis.tests) {
      result.push({ test, filePath: analysis.filePath });
    }
  }
  return result;
}

/** Match a PageSpec to a test by checking navigations against page.path. */
function findPageMatch(page: PageSpec, tests: FlatTest[]): FlatTest | null {
  // First try: test navigates to the page path
  for (const ft of tests) {
    for (const nav of ft.test.navigations) {
      if (pathMatches(nav, page.path)) {
        return ft;
      }
    }
  }

  // Second try: test name contains page id
  for (const ft of tests) {
    if (fuzzyNameMatch(ft.test.name, page.id)) {
      return ft;
    }
  }

  return null;
}

/** Match a ScenarioSpec to a test by name similarity. */
function findScenarioMatch(scenario: ScenarioSpec, page: PageSpec, tests: FlatTest[]): FlatTest | null {
  // Try matching by name
  for (const ft of tests) {
    if (fuzzyNameMatch(ft.test.name, scenario.id)) {
      return ft;
    }
    if (scenario.description && fuzzyNameMatch(ft.test.name, scenario.description)) {
      return ft;
    }
  }

  // Try matching by name + page navigation
  for (const ft of tests) {
    const navigatesToPage = ft.test.navigations.some(nav => pathMatches(nav, page.path));
    if (navigatesToPage && ft.test.interactions.length > 0) {
      // Check if interactions roughly match scenario steps
      const scenarioSelectors = new Set(
        scenario.steps
          .filter((s): s is ScenarioStep & { selector: string } => 'selector' in s && !!(s as unknown as { selector?: string }).selector)
          .map(s => s.selector)
      );
      const testSelectors = new Set(ft.test.interactions.map(i => i.selector).filter(Boolean));
      const overlap = [...scenarioSelectors].filter(s => testSelectors.has(s));
      if (overlap.length > 0) return ft;
    }
  }

  return null;
}

/** Match a FlowSpec to a test by navigations or name. */
function findFlowMatch(flow: FlowSpec, tests: FlatTest[]): FlatTest | null {
  // Extract navigate URLs from flow
  const flowNavs = flow.steps
    .filter((s): s is { navigate: string } => 'navigate' in s)
    .map(s => s.navigate);

  // A test matches if it navigates to multiple flow URLs
  if (flowNavs.length > 0) {
    for (const ft of tests) {
      const matchCount = flowNavs.filter(nav =>
        ft.test.navigations.some(tn => pathMatches(tn, nav))
      ).length;
      if (matchCount >= Math.ceil(flowNavs.length / 2)) {
        return ft;
      }
    }
  }

  // Try name match
  for (const ft of tests) {
    if (fuzzyNameMatch(ft.test.name, flow.id)) return ft;
    if (flow.description && fuzzyNameMatch(ft.test.name, flow.description)) return ft;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

function comparePageAssertions(page: PageSpec, test: TestCase): string[] {
  const diffs: string[] = [];

  // Check if spec has assertions that the test doesn't cover
  for (const assertion of page.visual_assertions ?? []) {
    if ('selector' in assertion) {
      const sel = assertion.selector;
      const testHasSel = test.assertions.some(a => a.selector === sel);
      if (!testHasSel) {
        diffs.push(`Spec asserts on selector "${sel}" but test does not check it`);
      }
    }
  }

  // Check if test has assertions on selectors not in spec
  for (const assertion of test.assertions) {
    if (assertion.selector) {
      const specHasSel = (page.visual_assertions ?? []).some(
        a => 'selector' in a && a.selector === assertion.selector
      );
      if (!specHasSel) {
        diffs.push(`Test asserts on selector "${assertion.selector}" but spec does not`);
      }
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testKey(filePath: string, testName: string): string {
  return `${filePath}::${testName}`;
}

/** Check if a navigation URL matches a page path. */
function pathMatches(navUrl: string, pagePath: string): boolean {
  // Normalize
  const normalizedPath = pagePath.replace(/^\//, '').replace(/\/$/, '');

  // Direct path match
  if (navUrl === pagePath) return true;
  if (navUrl.endsWith(pagePath)) return true;

  // Strip protocol+host from nav URL
  try {
    const url = new URL(navUrl);
    const navPath = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    if (navPath === normalizedPath) return true;
  } catch {
    // Not a full URL, compare as paths
    const navPath = navUrl.replace(/^\//, '').replace(/\/$/, '');
    if (navPath === normalizedPath) return true;
  }

  // Path parameter patterns: /users/:id matches /users/123
  if (pagePath.includes(':')) {
    const patternParts = pagePath.split('/');
    const navParts = navUrl.replace(/^https?:\/\/[^/]+/, '').split('/');
    if (patternParts.length === navParts.length) {
      const allMatch = patternParts.every(
        (part, i) => part.startsWith(':') || part === navParts[i]
      );
      if (allMatch) return true;
    }
  }

  return false;
}

/** Fuzzy name matching: checks if the test name relates to the spec id. */
function fuzzyNameMatch(testName: string, specId: string): boolean {
  const normalizedTest = testName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
  const normalizedSpec = specId.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();

  // Exact after normalization
  if (normalizedTest === normalizedSpec) return true;

  // Test name contains spec id
  if (normalizedTest.includes(normalizedSpec)) return true;

  // Spec id contains test name
  if (normalizedSpec.includes(normalizedTest)) return true;

  // Word overlap: if most words from spec id appear in test name
  const specWords = normalizedSpec.split(/\s+/).filter(w => w.length > 2);
  const testWords = new Set(normalizedTest.split(/\s+/));
  if (specWords.length > 0) {
    const overlap = specWords.filter(w => testWords.has(w)).length;
    if (overlap >= Math.ceil(specWords.length * 0.6)) return true;
  }

  return false;
}
