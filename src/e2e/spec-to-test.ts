/**
 * src/e2e/spec-to-test.ts — Code generator (spec → test)
 *
 * Reverses the mapping in src/agent/executor.ts to generate
 * Playwright or Cypress test code from spec definitions.
 */

import type { Spec, PageSpec, ScenarioSpec, ScenarioStep, FlowSpec, FlowStep, VisualAssertion, HooksSpec } from '../spec/types.js';
import type { GeneratedTestFile, GenerateOptions } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate test files from a spec. */
export function generateTestsFromSpec(spec: Spec, options: GenerateOptions): GeneratedTestFile[] {
  const { framework, baseUrl, splitFiles = false } = options;

  if (splitFiles) {
    return generateSplitFiles(spec, framework, baseUrl);
  }
  return [generateSingleFile(spec, framework, baseUrl)];
}

// ---------------------------------------------------------------------------
// Single file generation
// ---------------------------------------------------------------------------

function generateSingleFile(spec: Spec, framework: 'playwright' | 'cypress', baseUrl?: string): GeneratedTestFile {
  const ids: string[] = [];
  const lines: string[] = [];

  if (framework === 'playwright') {
    lines.push(`import { test, expect } from '@playwright/test';`);
    lines.push('');

    if (spec.hooks) {
      lines.push(...generatePlaywrightHooks(spec.hooks));
    }

    for (const page of spec.pages ?? []) {
      ids.push(page.id);
      lines.push(...generatePlaywrightPage(page, baseUrl));
      lines.push('');
    }

    for (const flow of spec.flows ?? []) {
      ids.push(flow.id);
      lines.push(...generatePlaywrightFlow(flow, spec, baseUrl));
      lines.push('');
    }
  } else {
    // Cypress
    if (spec.hooks) {
      lines.push(...generateCypressHooks(spec.hooks));
    }

    for (const page of spec.pages ?? []) {
      ids.push(page.id);
      lines.push(...generateCypressPage(page, baseUrl));
      lines.push('');
    }

    for (const flow of spec.flows ?? []) {
      ids.push(flow.id);
      lines.push(...generateCypressFlow(flow, spec, baseUrl));
      lines.push('');
    }
  }

  const ext = framework === 'playwright' ? 'spec.ts' : 'cy.ts';
  const fileName = sanitizeFileName(spec.name || 'spec') + '.' + ext;

  return {
    filePath: fileName,
    content: lines.join('\n'),
    framework,
    sourceSpecIds: ids,
  };
}

// ---------------------------------------------------------------------------
// Split file generation
// ---------------------------------------------------------------------------

function generateSplitFiles(spec: Spec, framework: 'playwright' | 'cypress', baseUrl?: string): GeneratedTestFile[] {
  const files: GeneratedTestFile[] = [];
  const ext = framework === 'playwright' ? 'spec.ts' : 'cy.ts';

  for (const page of spec.pages ?? []) {
    const lines: string[] = [];
    if (framework === 'playwright') {
      lines.push(`import { test, expect } from '@playwright/test';`);
      lines.push('');
      lines.push(...generatePlaywrightPage(page, baseUrl));
    } else {
      lines.push(...generateCypressPage(page, baseUrl));
    }
    files.push({
      filePath: `${sanitizeFileName(page.id)}.${ext}`,
      content: lines.join('\n'),
      framework,
      sourceSpecIds: [page.id],
    });
  }

  for (const flow of spec.flows ?? []) {
    const lines: string[] = [];
    if (framework === 'playwright') {
      lines.push(`import { test, expect } from '@playwright/test';`);
      lines.push('');
      lines.push(...generatePlaywrightFlow(flow, spec, baseUrl));
    } else {
      lines.push(...generateCypressFlow(flow, spec, baseUrl));
    }
    files.push({
      filePath: `${sanitizeFileName(flow.id)}.${ext}`,
      content: lines.join('\n'),
      framework,
      sourceSpecIds: [flow.id],
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Playwright generators
// ---------------------------------------------------------------------------

function generatePlaywrightHooks(hooks: HooksSpec): string[] {
  const lines: string[] = [];

  if (hooks.setup?.length) {
    lines.push(`test.beforeAll(async () => {`);
    for (const step of hooks.setup) {
      if (step.type === 'api_call') {
        lines.push(`  // ${step.name}`);
        lines.push(`  await fetch(${quote(step.url)}, {`);
        lines.push(`    method: ${quote(step.method)},`);
        if (step.headers) {
          lines.push(`    headers: ${JSON.stringify(step.headers)},`);
        }
        if (step.body !== undefined) {
          lines.push(`    body: JSON.stringify(${JSON.stringify(step.body)}),`);
        }
        lines.push(`  });`);
      } else if (step.type === 'shell') {
        lines.push(`  // ${step.name}`);
        lines.push(`  // Shell: ${step.command}`);
      }
    }
    lines.push(`});`);
    lines.push('');
  }

  if (hooks.teardown?.length) {
    lines.push(`test.afterAll(async () => {`);
    for (const step of hooks.teardown) {
      if (step.type === 'api_call') {
        lines.push(`  // ${step.name}`);
        lines.push(`  await fetch(${quote(step.url)}, { method: ${quote(step.method)} });`);
      } else if (step.type === 'shell') {
        lines.push(`  // ${step.name}`);
        lines.push(`  // Shell: ${step.command}`);
      }
    }
    lines.push(`});`);
    lines.push('');
  }

  return lines;
}

function generatePlaywrightPage(page: PageSpec, baseUrl?: string): string[] {
  const lines: string[] = [];
  const url = resolveUrl(page.path, baseUrl);

  lines.push(`test.describe(${quote(page.id)}, () => {`);

  // Visual assertions as a single test
  if (page.visual_assertions?.length) {
    lines.push(`  test(${quote(`${page.id} — visual assertions`)}, async ({ page }) => {`);
    lines.push(`    await page.goto(${quote(url)});`);
    for (const assertion of page.visual_assertions) {
      lines.push(...indent(2, generatePlaywrightAssertion(assertion)));
    }
    lines.push(`  });`);
  }

  // Scenarios as individual tests
  for (const scenario of page.scenarios ?? []) {
    lines.push('');
    lines.push(`  test(${quote(scenario.id + (scenario.description ? ` — ${scenario.description}` : ''))}, async ({ page }) => {`);
    lines.push(`    await page.goto(${quote(url)});`);
    for (const step of scenario.steps) {
      lines.push(...indent(2, generatePlaywrightStep(step)));
    }
    lines.push(`  });`);
  }

  lines.push(`});`);
  return lines;
}

function generatePlaywrightFlow(flow: FlowSpec, spec: Spec, baseUrl?: string): string[] {
  const lines: string[] = [];
  const label = flow.id + (flow.description ? ` — ${flow.description}` : '');

  lines.push(`test(${quote(label)}, async ({ page }) => {`);

  for (const step of flow.steps) {
    lines.push(...indent(1, generatePlaywrightFlowStep(step, spec, baseUrl)));
  }

  lines.push(`});`);
  return lines;
}

function generatePlaywrightAssertion(assertion: VisualAssertion): string[] {
  switch (assertion.type) {
    case 'element_exists':
      return [`await expect(page.locator(${quote(assertion.selector)})).toBeVisible();`];
    case 'text_contains':
      return [`await expect(page.locator(${quote(assertion.selector)})).toContainText(${quote(assertion.text)});`];
    case 'text_matches':
      return [`await expect(page.locator(${quote(assertion.selector)})).toHaveText(${regexLiteral(assertion.pattern)});`];
    case 'element_count':
      if (assertion.min !== undefined && assertion.min === assertion.max) {
        return [`await expect(page.locator(${quote(assertion.selector)})).toHaveCount(${assertion.min});`];
      }
      // For range checks, use count()
      return [`expect(await page.locator(${quote(assertion.selector)}).count()).toBeGreaterThanOrEqual(${assertion.min ?? 0});`];
    case 'screenshot_region':
      return [`await expect(page.locator(${quote(assertion.selector)})).toHaveScreenshot();`];
    default:
      return [];
  }
}

function generatePlaywrightStep(step: ScenarioStep): string[] {
  const desc = step.description ? `  // ${step.description}` : '';
  const lines: string[] = [];

  switch (step.action) {
    case 'click':
      lines.push(`await page.locator(${quote(step.selector)}).click();${desc}`);
      break;
    case 'fill':
      lines.push(`await page.locator(${quote(step.selector)}).fill(${quote(step.value)});${desc}`);
      break;
    case 'select':
      lines.push(`await page.locator(${quote(step.selector)}).selectOption(${quote(step.value)});${desc}`);
      break;
    case 'hover':
      lines.push(`await page.locator(${quote(step.selector)}).hover();${desc}`);
      break;
    case 'keypress':
      lines.push(`await page.keyboard.press(${quote(step.key)});${desc}`);
      break;
    case 'scroll':
      if (step.selector) {
        lines.push(`await page.locator(${quote(step.selector)}).scrollIntoViewIfNeeded();${desc}`);
      } else {
        const dir = step.direction === 'bottom' ? 'document.body.scrollHeight' : '0';
        lines.push(`await page.evaluate(() => window.scrollTo(0, ${dir}));${desc}`);
      }
      break;
    case 'wait':
      lines.push(`await page.waitForTimeout(${step.duration});${desc}`);
      break;
    case 'wait_for_request':
      lines.push(`await page.waitForRequest(${quote(step.url_pattern)});${desc}`);
      break;
    case 'wait_for_navigation':
      lines.push(`await page.waitForURL(${quote(step.url_pattern)});${desc}`);
      break;
    case 'assert_visible':
      lines.push(`await expect(page.locator(${quote(step.selector)})).toBeVisible();${desc}`);
      break;
    case 'assert_text':
      lines.push(`await expect(page.locator(${quote(step.selector)})).toContainText(${quote(step.text)});${desc}`);
      break;
    case 'assert_not_visible':
      lines.push(`await expect(page.locator(${quote(step.selector)})).toBeHidden();${desc}`);
      break;
  }

  return lines;
}

function generatePlaywrightFlowStep(step: FlowStep, spec: Spec, baseUrl?: string): string[] {
  if ('navigate' in step) {
    const url = resolveUrl(step.navigate, baseUrl);
    const desc = step.description ? `  // ${step.description}` : '';
    return [`await page.goto(${quote(url)});${desc}`];
  }
  if ('assert_page' in step) {
    const page = spec.pages?.find(p => p.id === step.assert_page);
    const lines: string[] = [];
    if (step.description) lines.push(`// ${step.description}`);
    if (page?.visual_assertions) {
      for (const a of page.visual_assertions) {
        lines.push(...generatePlaywrightAssertion(a));
      }
    } else {
      lines.push(`// assert_page: ${step.assert_page} (no assertions defined)`);
    }
    return lines;
  }
  if ('action' in step) {
    // ActionFlowStep is now ScenarioStep — no conversion needed
    return generatePlaywrightStep(step);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Cypress generators
// ---------------------------------------------------------------------------

function generateCypressHooks(hooks: HooksSpec): string[] {
  const lines: string[] = [];

  if (hooks.setup?.length) {
    lines.push(`before(() => {`);
    for (const step of hooks.setup) {
      if (step.type === 'api_call') {
        lines.push(`  // ${step.name}`);
        lines.push(`  cy.request(${quote(step.method)}, ${quote(step.url)}${step.body !== undefined ? `, ${JSON.stringify(step.body)}` : ''});`);
      } else if (step.type === 'shell') {
        lines.push(`  // ${step.name}`);
        lines.push(`  cy.exec(${quote(step.command)});`);
      }
    }
    lines.push(`});`);
    lines.push('');
  }

  if (hooks.teardown?.length) {
    lines.push(`after(() => {`);
    for (const step of hooks.teardown) {
      if (step.type === 'api_call') {
        lines.push(`  // ${step.name}`);
        lines.push(`  cy.request(${quote(step.method)}, ${quote(step.url)});`);
      } else if (step.type === 'shell') {
        lines.push(`  // ${step.name}`);
        lines.push(`  cy.exec(${quote(step.command)});`);
      }
    }
    lines.push(`});`);
    lines.push('');
  }

  return lines;
}

function generateCypressPage(page: PageSpec, baseUrl?: string): string[] {
  const lines: string[] = [];
  const url = resolveUrl(page.path, baseUrl);

  lines.push(`describe(${quote(page.id)}, () => {`);

  if (page.visual_assertions?.length) {
    lines.push(`  it(${quote(`${page.id} — visual assertions`)}, () => {`);
    lines.push(`    cy.visit(${quote(url)});`);
    for (const assertion of page.visual_assertions) {
      lines.push(...indent(2, generateCypressAssertion(assertion)));
    }
    lines.push(`  });`);
  }

  for (const scenario of page.scenarios ?? []) {
    lines.push('');
    lines.push(`  it(${quote(scenario.id + (scenario.description ? ` — ${scenario.description}` : ''))}, () => {`);
    lines.push(`    cy.visit(${quote(url)});`);
    for (const step of scenario.steps) {
      lines.push(...indent(2, generateCypressStep(step)));
    }
    lines.push(`  });`);
  }

  lines.push(`});`);
  return lines;
}

function generateCypressFlow(flow: FlowSpec, spec: Spec, baseUrl?: string): string[] {
  const lines: string[] = [];
  const label = flow.id + (flow.description ? ` — ${flow.description}` : '');

  lines.push(`it(${quote(label)}, () => {`);

  for (const step of flow.steps) {
    lines.push(...indent(1, generateCypressFlowStep(step, spec, baseUrl)));
  }

  lines.push(`});`);
  return lines;
}

function generateCypressAssertion(assertion: VisualAssertion): string[] {
  switch (assertion.type) {
    case 'element_exists':
      return [`cy.get(${quote(assertion.selector)}).should('be.visible');`];
    case 'text_contains':
      return [`cy.get(${quote(assertion.selector)}).should('contain', ${quote(assertion.text)});`];
    case 'text_matches':
      return [`cy.get(${quote(assertion.selector)}).invoke('text').should('match', ${regexLiteral(assertion.pattern)});`];
    case 'element_count':
      if (assertion.min !== undefined && assertion.min === assertion.max) {
        return [`cy.get(${quote(assertion.selector)}).should('have.length', ${assertion.min});`];
      }
      return [`cy.get(${quote(assertion.selector)}).should('have.length.at.least', ${assertion.min ?? 0});`];
    case 'screenshot_region':
      return [`// Visual regression not directly supported in Cypress without plugins`];
    default:
      return [];
  }
}

function generateCypressStep(step: ScenarioStep): string[] {
  const desc = step.description ? `  // ${step.description}` : '';
  const lines: string[] = [];

  switch (step.action) {
    case 'click':
      lines.push(`cy.get(${quote(step.selector)}).click();${desc}`);
      break;
    case 'fill':
      lines.push(`cy.get(${quote(step.selector)}).clear().type(${quote(step.value)});${desc}`);
      break;
    case 'select':
      lines.push(`cy.get(${quote(step.selector)}).select(${quote(step.value)});${desc}`);
      break;
    case 'hover':
      lines.push(`cy.get(${quote(step.selector)}).trigger('mouseover');${desc}`);
      break;
    case 'keypress':
      lines.push(`cy.get('body').type(${quote(`{${step.key.toLowerCase()}}`)});${desc}`);
      break;
    case 'scroll':
      if (step.selector) {
        lines.push(`cy.get(${quote(step.selector)}).scrollIntoView();${desc}`);
      } else {
        lines.push(`cy.scrollTo(${quote(step.direction ?? 'top')});${desc}`);
      }
      break;
    case 'wait':
      lines.push(`cy.wait(${step.duration});${desc}`);
      break;
    case 'wait_for_request':
      lines.push(`// Wait for request: ${step.url_pattern}${desc}`);
      break;
    case 'wait_for_navigation':
      lines.push(`cy.url().should('include', ${quote(step.url_pattern)});${desc}`);
      break;
    case 'assert_visible':
      lines.push(`cy.get(${quote(step.selector)}).should('be.visible');${desc}`);
      break;
    case 'assert_text':
      lines.push(`cy.get(${quote(step.selector)}).should('contain', ${quote(step.text)});${desc}`);
      break;
    case 'assert_not_visible':
      lines.push(`cy.get(${quote(step.selector)}).should('not.be.visible');${desc}`);
      break;
  }

  return lines;
}

function generateCypressFlowStep(step: FlowStep, spec: Spec, baseUrl?: string): string[] {
  if ('navigate' in step) {
    const url = resolveUrl(step.navigate, baseUrl);
    const desc = step.description ? `  // ${step.description}` : '';
    return [`cy.visit(${quote(url)});${desc}`];
  }
  if ('assert_page' in step) {
    const page = spec.pages?.find(p => p.id === step.assert_page);
    const lines: string[] = [];
    if (step.description) lines.push(`// ${step.description}`);
    if (page?.visual_assertions) {
      for (const a of page.visual_assertions) {
        lines.push(...generateCypressAssertion(a));
      }
    } else {
      lines.push(`// assert_page: ${step.assert_page} (no assertions defined)`);
    }
    return lines;
  }
  if ('action' in step) {
    // ActionFlowStep is now ScenarioStep — no conversion needed
    return generateCypressStep(step);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUrl(pagePath: string, baseUrl?: string): string {
  if (pagePath.startsWith('http://') || pagePath.startsWith('https://')) return pagePath;
  if (baseUrl) {
    const base = baseUrl.replace(/\/$/, '');
    const p = pagePath.startsWith('/') ? pagePath : '/' + pagePath;
    return base + p;
  }
  return pagePath;
}

function quote(s: string): string {
  // Use single quotes, escape any internal single quotes
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function regexLiteral(pattern: string): string {
  return `/${pattern}/`;
}

function sanitizeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function indent(level: number, lines: string[]): string[] {
  const prefix = '  '.repeat(level);
  return lines.map(l => prefix + l);
}
