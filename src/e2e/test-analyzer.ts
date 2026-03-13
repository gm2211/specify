/**
 * src/e2e/test-analyzer.ts — Heuristic test file parser
 *
 * Best-effort extraction of test structure from Playwright and Cypress
 * test files using pattern matching. Always includes raw source ranges
 * so LLM callers can do deeper analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  TestFileAnalysis,
  TestFramework,
  TestSuite,
  TestCase,
  TestInteraction,
  TestAssertion,
  NetworkPattern,
  SourceRange,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Analyze a single test file. */
export function analyzeTestFile(filePath: string, framework?: TestFramework): TestFileAnalysis {
  const absPath = path.resolve(filePath);
  const source = fs.readFileSync(absPath, 'utf-8');
  const detected = framework ?? detectFramework(absPath, source);
  const lines = source.split('\n');

  const suites: TestSuite[] = [];
  const tests: TestCase[] = [];

  // Find describe blocks
  const describeBlocks = findBlocks(lines, /^\s*(?:test\.)?describe\s*\(\s*(['"`])(.+?)\1/);
  for (const block of describeBlocks) {
    const innerTests = findTestCases(lines, block.startLine, block.endLine, detected);
    suites.push({
      name: block.name,
      tests: innerTests,
      sourceRange: { startLine: block.startLine, endLine: block.endLine },
    });
  }

  // Find top-level test cases (not inside describe blocks)
  const allTests = findTestCases(lines, 0, lines.length - 1, detected);
  for (const tc of allTests) {
    const insideSuite = suites.some(
      s => tc.sourceRange.startLine >= s.sourceRange.startLine &&
           tc.sourceRange.endLine <= s.sourceRange.endLine
    );
    if (!insideSuite) {
      tests.push(tc);
    }
  }

  return { filePath: absPath, framework: detected, suites, tests };
}

/** Analyze all test files in a directory. */
export function analyzeTestDirectory(dir: string, framework?: TestFramework): TestFileAnalysis[] {
  const absDir = path.resolve(dir);
  const files = collectTestFiles(absDir);
  return files.map(f => analyzeTestFile(f, framework));
}

/** Detect which framework a test file uses. */
export function detectFramework(filePath: string, source?: string): TestFramework {
  const content = source ?? fs.readFileSync(path.resolve(filePath), 'utf-8');
  const basename = path.basename(filePath);

  // Check imports and patterns
  if (content.includes('@playwright/test') || content.includes('from \'playwright\'') || basename.includes('.spec.')) {
    return 'playwright';
  }
  if (content.includes('cy.') || content.includes('cypress') || basename.includes('.cy.')) {
    return 'cypress';
  }
  if (content.includes('page.goto') || content.includes('page.locator')) {
    return 'playwright';
  }
  if (content.includes('cy.visit') || content.includes('cy.get')) {
    return 'cypress';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Block finding
// ---------------------------------------------------------------------------

interface Block {
  name: string;
  startLine: number;
  endLine: number;
}

/** Find brace-delimited blocks starting with a pattern. */
function findBlocks(lines: string[], pattern: RegExp): Block[] {
  const blocks: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(pattern);
    if (!match) continue;

    const name = match[2];
    const endLine = findMatchingBrace(lines, i);
    blocks.push({ name, startLine: i + 1, endLine: endLine + 1 }); // 1-based
  }

  return blocks;
}

/** Find the line of the closing brace that matches the first opening brace at/after startLine. */
function findMatchingBrace(lines: string[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; foundOpen = true; }
      if (ch === '}') { depth--; }
      if (foundOpen && depth === 0) return i;
    }
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// Test case extraction
// ---------------------------------------------------------------------------

/** Pattern for test/it declarations. */
const TEST_PATTERN = /^\s*(?:test|it)\s*\(\s*(['"`])(.+?)\1/;

function findTestCases(lines: string[], rangeStart: number, rangeEnd: number, framework: TestFramework): TestCase[] {
  const cases: TestCase[] = [];

  for (let i = rangeStart; i <= rangeEnd && i < lines.length; i++) {
    const lineIdx = i; // 0-based index in lines array
    const match = lines[lineIdx]?.match(TEST_PATTERN);
    if (!match) continue;

    const name = match[2];
    const bodyEnd = findMatchingBrace(lines, lineIdx);
    const rawSource = lines.slice(lineIdx, bodyEnd + 1).join('\n');

    const navigations = extractNavigations(rawSource, framework);
    const interactions = extractInteractions(rawSource, framework);
    const assertions = extractAssertions(rawSource, framework);
    const networkPatterns = extractNetworkPatterns(rawSource, framework);

    cases.push({
      name,
      navigations,
      interactions,
      assertions,
      networkPatterns,
      sourceRange: { startLine: lineIdx + 1, endLine: bodyEnd + 1 }, // 1-based
      rawSource,
    });
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Navigation extraction
// ---------------------------------------------------------------------------

function extractNavigations(source: string, framework: TestFramework): string[] {
  const navs: string[] = [];

  if (framework === 'playwright' || framework === 'unknown') {
    // page.goto('url') or page.goto("url") or page.goto(`url`)
    const gotos = source.matchAll(/page\.goto\s*\(\s*(['"`])(.+?)\1/g);
    for (const m of gotos) navs.push(m[2]);
  }

  if (framework === 'cypress' || framework === 'unknown') {
    // cy.visit('url')
    const visits = source.matchAll(/cy\.visit\s*\(\s*(['"`])(.+?)\1/g);
    for (const m of visits) navs.push(m[2]);
  }

  return navs;
}

// ---------------------------------------------------------------------------
// Interaction extraction
// ---------------------------------------------------------------------------

function extractInteractions(source: string, framework: TestFramework): TestInteraction[] {
  const interactions: TestInteraction[] = [];

  if (framework === 'playwright' || framework === 'unknown') {
    // locator('sel').click()
    for (const m of source.matchAll(/(?:page\.locator|page\.getByRole|page\.getByText|page\.getByLabel)\s*\(\s*(['"`])(.+?)\1\s*\)\.click\s*\(/g)) {
      interactions.push({ type: 'click', selector: m[2], raw: m[0] });
    }
    // locator('sel').fill('val')
    for (const m of source.matchAll(/(?:page\.locator|page\.getByRole|page\.getByLabel)\s*\(\s*(['"`])(.+?)\1\s*\)\.fill\s*\(\s*(['"`])(.+?)\3/g)) {
      interactions.push({ type: 'fill', selector: m[2], value: m[4], raw: m[0] });
    }
    // locator('sel').selectOption('val')
    for (const m of source.matchAll(/(?:page\.locator)\s*\(\s*(['"`])(.+?)\1\s*\)\.selectOption\s*\(\s*(['"`])(.+?)\3/g)) {
      interactions.push({ type: 'select', selector: m[2], value: m[4], raw: m[0] });
    }
    // locator('sel').hover()
    for (const m of source.matchAll(/(?:page\.locator)\s*\(\s*(['"`])(.+?)\1\s*\)\.hover\s*\(/g)) {
      interactions.push({ type: 'hover', selector: m[2], raw: m[0] });
    }
    // page.keyboard.press('key')
    for (const m of source.matchAll(/page\.keyboard\.press\s*\(\s*(['"`])(.+?)\1/g)) {
      interactions.push({ type: 'keypress', value: m[2], raw: m[0] });
    }
  }

  if (framework === 'cypress' || framework === 'unknown') {
    // cy.get('sel').click()
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.click\s*\(/g)) {
      interactions.push({ type: 'click', selector: m[2], raw: m[0] });
    }
    // cy.get('sel').type('val')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.type\s*\(\s*(['"`])(.+?)\3/g)) {
      interactions.push({ type: 'fill', selector: m[2], value: m[4], raw: m[0] });
    }
    // cy.get('sel').select('val')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.select\s*\(\s*(['"`])(.+?)\3/g)) {
      interactions.push({ type: 'select', selector: m[2], value: m[4], raw: m[0] });
    }
  }

  return interactions;
}

// ---------------------------------------------------------------------------
// Assertion extraction
// ---------------------------------------------------------------------------

function extractAssertions(source: string, framework: TestFramework): TestAssertion[] {
  const assertions: TestAssertion[] = [];

  if (framework === 'playwright' || framework === 'unknown') {
    // expect(locator).toBeVisible()
    for (const m of source.matchAll(/(?:page\.locator|page\.getByRole|page\.getByText)\s*\(\s*(['"`])(.+?)\1\s*\)[\s\S]*?\.toBeVisible\s*\(/g)) {
      assertions.push({ type: 'visible', selector: m[2], raw: m[0] });
    }
    // expect(locator).toBeHidden()
    for (const m of source.matchAll(/(?:page\.locator|page\.getByRole|page\.getByText)\s*\(\s*(['"`])(.+?)\1\s*\)[\s\S]*?\.toBeHidden\s*\(/g)) {
      assertions.push({ type: 'not_visible', selector: m[2], raw: m[0] });
    }
    // expect(locator).toHaveText('text')
    for (const m of source.matchAll(/(?:page\.locator|page\.getByRole|page\.getByText)\s*\(\s*(['"`])(.+?)\1\s*\)[\s\S]*?\.toHaveText\s*\(\s*(['"`])(.+?)\3/g)) {
      assertions.push({ type: 'text', selector: m[2], expected: m[4], raw: m[0] });
    }
    // expect(locator).toContainText('text')
    for (const m of source.matchAll(/(?:page\.locator|page\.getByRole|page\.getByText)\s*\(\s*(['"`])(.+?)\1\s*\)[\s\S]*?\.toContainText\s*\(\s*(['"`])(.+?)\3/g)) {
      assertions.push({ type: 'text', selector: m[2], expected: m[4], raw: m[0] });
    }
    // expect(locator).toHaveCount(n)
    for (const m of source.matchAll(/(?:page\.locator)\s*\(\s*(['"`])(.+?)\1\s*\)[\s\S]*?\.toHaveCount\s*\(\s*(\d+)/g)) {
      assertions.push({ type: 'count', selector: m[2], expected: m[3], raw: m[0] });
    }
    // expect(page).toHaveURL('url')
    for (const m of source.matchAll(/expect\s*\(\s*page\s*\)[\s\S]*?\.toHaveURL\s*\(\s*(['"`])(.+?)\1/g)) {
      assertions.push({ type: 'url', expected: m[2], raw: m[0] });
    }
    // locator.waitFor({state:'visible'})
    for (const m of source.matchAll(/(?:page\.locator)\s*\(\s*(['"`])(.+?)\1\s*\)\.waitFor\s*\(\s*\{[^}]*state\s*:\s*['"`]visible/g)) {
      assertions.push({ type: 'visible', selector: m[2], raw: m[0] });
    }
  }

  if (framework === 'cypress' || framework === 'unknown') {
    // cy.get('sel').should('be.visible')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.should\s*\(\s*(['"`])be\.visible\3/g)) {
      assertions.push({ type: 'visible', selector: m[2], raw: m[0] });
    }
    // cy.get('sel').should('not.be.visible') / should('not.exist')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.should\s*\(\s*(['"`])not\.(?:be\.visible|exist)\3/g)) {
      assertions.push({ type: 'not_visible', selector: m[2], raw: m[0] });
    }
    // cy.get('sel').should('exist')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.should\s*\(\s*(['"`])exist\3/g)) {
      assertions.push({ type: 'exists', selector: m[2], raw: m[0] });
    }
    // cy.get('sel').should('contain', 'text')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.should\s*\(\s*(['"`])contain\3\s*,\s*(['"`])(.+?)\4/g)) {
      assertions.push({ type: 'text', selector: m[2], expected: m[5], raw: m[0] });
    }
    // cy.get('sel').should('have.text', 'text')
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.should\s*\(\s*(['"`])have\.text\3\s*,\s*(['"`])(.+?)\4/g)) {
      assertions.push({ type: 'text', selector: m[2], expected: m[5], raw: m[0] });
    }
    // cy.url().should('include', 'path')
    for (const m of source.matchAll(/cy\.url\s*\(\s*\)\.should\s*\(\s*(['"`])include\1\s*,\s*(['"`])(.+?)\2/g)) {
      assertions.push({ type: 'url', expected: m[3], raw: m[0] });
    }
    // cy.get('sel').should('have.length', n)
    for (const m of source.matchAll(/cy\.get\s*\(\s*(['"`])(.+?)\1\s*\)\.should\s*\(\s*(['"`])have\.length\3\s*,\s*(\d+)/g)) {
      assertions.push({ type: 'count', selector: m[2], expected: m[4], raw: m[0] });
    }
  }

  return assertions;
}

// ---------------------------------------------------------------------------
// Network pattern extraction
// ---------------------------------------------------------------------------

function extractNetworkPatterns(source: string, framework: TestFramework): NetworkPattern[] {
  const patterns: NetworkPattern[] = [];

  if (framework === 'playwright' || framework === 'unknown') {
    // page.waitForRequest('url')
    for (const m of source.matchAll(/page\.waitForRequest\s*\(\s*(['"`])(.+?)\1/g)) {
      patterns.push({ urlPattern: m[2], raw: m[0] });
    }
    // page.waitForResponse('url')
    for (const m of source.matchAll(/page\.waitForResponse\s*\(\s*(['"`])(.+?)\1/g)) {
      patterns.push({ urlPattern: m[2], raw: m[0] });
    }
    // page.route('url', ...)
    for (const m of source.matchAll(/page\.route\s*\(\s*(['"`])(.+?)\1/g)) {
      patterns.push({ urlPattern: m[2], raw: m[0] });
    }
  }

  if (framework === 'cypress' || framework === 'unknown') {
    // cy.intercept('METHOD', 'url')
    for (const m of source.matchAll(/cy\.intercept\s*\(\s*(['"`])(GET|POST|PUT|DELETE|PATCH)\1\s*,\s*(['"`])(.+?)\3/g)) {
      patterns.push({ urlPattern: m[4], method: m[2], raw: m[0] });
    }
    // cy.intercept('url')
    for (const m of source.matchAll(/cy\.intercept\s*\(\s*(['"`])([^'"` ]+)\1\s*[,)]/g)) {
      if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(m[2])) {
        patterns.push({ urlPattern: m[2], raw: m[0] });
      }
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  const testPatterns = [
    /\.spec\.[jt]sx?$/,
    /\.test\.[jt]sx?$/,
    /\.cy\.[jt]sx?$/,
    /\.e2e\.[jt]sx?$/,
  ];

  function walk(d: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile()) {
        if (testPatterns.some(p => p.test(entry.name))) {
          results.push(full);
        }
      }
    }
  }

  walk(dir);
  return results.sort();
}
