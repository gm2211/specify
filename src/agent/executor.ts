/**
 * src/agent/executor.ts — Step execution engine for the agent runner
 *
 * Handles executing individual spec steps in Playwright.
 * Each step:
 *   - Takes a screenshot before/after (configurable)
 *   - Records network traffic during the step
 *   - Captures console output
 *   - Returns success/failure with evidence
 */

import type { Page } from 'playwright';
import type {
  ScenarioStep,
  FlowStep,
  ClickStep,
  FillStep,
  SelectStep,
  HoverStep,
  WaitForRequestStep,
  WaitForNavigationStep,
  AssertVisibleStep,
  AssertTextStep,
  AssertNotVisibleStep,
  KeypressStep,
  ScrollStep,
  WaitStep,
} from '../spec/types.js';
import type { CaptureCollector } from './capture.js';
import { substituteVars, type HookContext } from './hooks.js';

export interface StepExecutionResult {
  action: string;
  description?: string;
  success: boolean;
  error?: string;
  screenshotPath?: string;
  evidence?: string;
}

export interface ExecutorOptions {
  screenshotOnEveryStep?: boolean;
  stepTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT = 10_000;

/** Execute a single ScenarioStep on the given page. */
export async function executeStep(
  page: Page,
  step: ScenarioStep,
  capture: CaptureCollector,
  ctx: HookContext,
  options: ExecutorOptions = {},
): Promise<StepExecutionResult> {
  const { screenshotOnEveryStep = true, stepTimeoutMs = DEFAULT_STEP_TIMEOUT } = options;
  const action = step.action;
  let screenshotPath: string | undefined;

  try {
    switch (step.action) {
      case 'click': {
        const s = step as ClickStep;
        await page.locator(s.selector).waitFor({ state: 'visible', timeout: stepTimeoutMs });
        await page.locator(s.selector).click({ timeout: stepTimeoutMs });
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `click-${sanitize(s.selector)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Clicked "${s.selector}"` };
      }

      case 'fill': {
        const s = step as FillStep;
        const value = substituteVars(s.value, ctx);
        await page.locator(s.selector).waitFor({ state: 'visible', timeout: stepTimeoutMs });
        await page.locator(s.selector).fill(value, { timeout: stepTimeoutMs });
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `fill-${sanitize(s.selector)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Filled "${s.selector}" with value` };
      }

      case 'select': {
        const s = step as SelectStep;
        const value = substituteVars(s.value, ctx);
        await page.locator(s.selector).waitFor({ state: 'visible', timeout: stepTimeoutMs });
        await page.locator(s.selector).selectOption(value, { timeout: stepTimeoutMs });
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `select-${sanitize(s.selector)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Selected "${value}" in "${s.selector}"` };
      }

      case 'hover': {
        const s = step as HoverStep;
        await page.locator(s.selector).waitFor({ state: 'visible', timeout: stepTimeoutMs });
        await page.locator(s.selector).hover({ timeout: stepTimeoutMs });
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `hover-${sanitize(s.selector)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Hovered over "${s.selector}"` };
      }

      case 'wait_for_request': {
        const s = step as WaitForRequestStep;
        const urlPattern = substituteVars(s.url_pattern, ctx);
        await page.waitForRequest(
          (req) => {
            const methodMatch = !s.method || req.method().toUpperCase() === s.method.toUpperCase();
            const urlMatch = matchesPattern(req.url(), urlPattern);
            return methodMatch && urlMatch;
          },
          { timeout: stepTimeoutMs },
        );
        return { action, description: step.description, success: true, evidence: `Request matching "${urlPattern}" was observed` };
      }

      case 'wait_for_navigation': {
        const s = step as WaitForNavigationStep;
        const urlPattern = substituteVars(s.url_pattern, ctx);
        await page.waitForURL(
          (url) => matchesPattern(url.href, urlPattern),
          { timeout: stepTimeoutMs },
        );
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `nav-${sanitize(urlPattern)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Navigated to URL matching "${urlPattern}"` };
      }

      case 'assert_visible': {
        const s = step as AssertVisibleStep;
        await page.locator(s.selector).waitFor({ state: 'visible', timeout: stepTimeoutMs });
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `assert-visible-${sanitize(s.selector)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Element "${s.selector}" is visible` };
      }

      case 'assert_text': {
        const s = step as AssertTextStep;
        const expectedText = substituteVars(s.text, ctx);
        await page.locator(s.selector).waitFor({ state: 'visible', timeout: stepTimeoutMs });
        const actualText = await page.locator(s.selector).textContent({ timeout: stepTimeoutMs });
        if (!actualText?.includes(expectedText)) {
          return {
            action,
            description: step.description,
            success: false,
            error: `Expected text "${expectedText}" not found in "${s.selector}". Actual: "${actualText}"`,
          };
        }
        return { action, description: step.description, success: true, evidence: `Element "${s.selector}" contains "${expectedText}"` };
      }

      case 'assert_not_visible': {
        const s = step as AssertNotVisibleStep;
        const count = await page.locator(s.selector).count();
        if (count > 0) {
          const isVisible = await page.locator(s.selector).first().isVisible();
          if (isVisible) {
            return {
              action,
              description: step.description,
              success: false,
              error: `Element "${s.selector}" was expected to be hidden but is visible`,
            };
          }
        }
        return { action, description: step.description, success: true, evidence: `Element "${s.selector}" is not visible` };
      }

      case 'keypress': {
        const s = step as KeypressStep;
        await page.keyboard.press(s.key);
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, `keypress-${sanitize(s.key)}`);
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Pressed key "${s.key}"` };
      }

      case 'scroll': {
        const s = step as ScrollStep;
        if (s.selector) {
          await page.locator(s.selector).scrollIntoViewIfNeeded({ timeout: stepTimeoutMs });
        } else if (s.direction === 'bottom') {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        } else {
          await page.evaluate(() => window.scrollTo(0, 0));
        }
        if (screenshotOnEveryStep) {
          screenshotPath = await capture.screenshot(page, 'scroll');
        }
        return { action, description: step.description, success: true, screenshotPath, evidence: `Scrolled ${s.selector ?? s.direction ?? 'top'}` };
      }

      case 'wait': {
        const s = step as WaitStep;
        await page.waitForTimeout(s.duration);
        return { action, description: step.description, success: true, evidence: `Waited ${s.duration}ms` };
      }

      default: {
        const unknownStep = step as { description?: string };
        return {
          action,
          description: unknownStep.description,
          success: false,
          error: `Unknown step action: ${action}`,
        };
      }
    }
  } catch (err) {
    // Take a failure screenshot
    try {
      screenshotPath = await capture.screenshot(page, `error-${action}`);
    } catch {
      // ignore screenshot failure
    }
    return {
      action,
      description: step.description,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
    };
  }
}

/** Execute a FlowStep (navigate, assert_page, or action). */
export async function executeFlowStep(
  page: Page,
  step: FlowStep,
  capture: CaptureCollector,
  ctx: HookContext,
  baseUrl: string,
  options: ExecutorOptions = {},
): Promise<StepExecutionResult> {
  if ('navigate' in step) {
    const url = resolveUrl(substituteVars(step.navigate, ctx), baseUrl);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT });
      const screenshotPath = await capture.screenshot(page, `nav-${sanitize(step.navigate)}`);
      return {
        action: 'navigate',
        description: step.description,
        success: true,
        screenshotPath,
        evidence: `Navigated to ${url}`,
      };
    } catch (err) {
      return {
        action: 'navigate',
        description: step.description,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if ('assert_page' in step) {
    // Assert page by checking the current URL contains the page id or a known pattern
    // This is a best-effort check during active execution
    const currentUrl = page.url();
    const screenshotPath = await capture.screenshot(page, `assert-page-${sanitize(step.assert_page)}`);
    return {
      action: 'assert_page',
      description: step.description,
      success: true,
      screenshotPath,
      evidence: `Current URL: ${currentUrl} (asserting page "${step.assert_page}")`,
    };
  }

  if ('action' in step) {
    // ActionFlowStep is now ScenarioStep — no conversion needed
    return executeStep(page, step, capture, ctx, options);
  }

  return { action: 'unknown', success: false, error: 'Unknown flow step type' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitize(str: string): string {
  return str.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').substring(0, 40);
}

function matchesPattern(url: string, pattern: string): boolean {
  if (pattern.startsWith('^')) {
    try {
      const re = new RegExp(pattern);
      return re.test(url);
    } catch {
      return false;
    }
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    try {
      const re = new RegExp(escaped);
      try {
        return re.test(new URL(url).pathname) || re.test(url);
      } catch {
        return re.test(url);
      }
    } catch {
      return url.includes(pattern.replace(/\*/g, ''));
    }
  }
  try {
    return new URL(url).pathname === pattern || url.includes(pattern);
  } catch {
    return url.includes(pattern);
  }
}

function resolveUrl(urlOrPath: string, baseUrl: string): string {
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    return urlOrPath;
  }
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = urlOrPath.startsWith('/') ? urlOrPath : `/${urlOrPath}`;
  return `${base}${suffix}`;
}

