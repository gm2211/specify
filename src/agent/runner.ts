/**
 * src/agent/runner.ts — Main orchestrator for the agent runner
 *
 * Takes a spec + target URL and:
 *   1. Reads the spec to understand what needs to be tested
 *   2. Runs setup hooks (API calls to create test data, etc.)
 *   3. Launches Playwright browser (headless by default)
 *   4. Sets up traffic interception
 *   5. Executes pages, scenarios, and flows
 *   6. Saves all captures in the standard format
 *   7. Runs the validation engine
 *   8. Generates the gap report (markdown and JSON)
 *   9. Runs teardown hooks
 *  10. Returns the gap report
 */

import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { loadSpec } from '../spec/parser.js';
import type { Spec, PageSpec, FlowSpec } from '../spec/types.js';
import { validate, loadCaptureData } from '../validation/validator.js';
import type { GapReport } from '../validation/types.js';
import { toMarkdown, toJson } from '../validation/reporter.js';
import { CaptureCollector } from './capture.js';
import { executeHooks, type HookContext } from './hooks.js';
import { executeStep, executeFlowStep } from './executor.js';
import { planExploration } from './explorer.js';
import type { CapturedTraffic, CapturedConsoleEntry } from '../capture/types.js';

export interface AgentConfig {
  /** Path to spec YAML/JSON */
  specPath: string;
  /** Base URL to test against */
  targetUrl: string;
  /** Run browser in headless mode (default: true) */
  headless?: boolean;
  /** Where to save captures + report */
  outputDir?: string;
  hooks?: {
    /** Run setup hooks (default: true) */
    setup?: boolean;
    /** Run teardown hooks (default: true) */
    teardown?: boolean;
  };
  /** Overall timeout in ms (default: 5 minutes) */
  timeout?: number;
  /** Take a screenshot on every step (default: true) */
  screenshotOnEveryStep?: boolean;
  /** Log function (default: console.log) */
  log?: (msg: string) => void;
  /** Enable adaptive exploration of untested assertions */
  explore?: boolean;
  /** Maximum rounds of exploration (default: 2) */
  maxExplorationRounds?: number;
  /** Resume from existing capture directory */
  resumeDir?: string;
}

export interface AgentRunResult {
  report: GapReport;
  outputDir: string;
  reportMarkdownPath: string;
  reportJsonPath: string;
  captureDir: string;
  errors: string[];
}

function defaultOutputDir(specPath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const specName = path.basename(specPath, path.extname(specPath));
  return path.resolve('agent-runs', `${specName}_${timestamp}`);
}

function resolveUrl(urlOrPath: string, baseUrl: string): string {
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    return urlOrPath;
  }
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = urlOrPath.startsWith('/') ? urlOrPath : `/${urlOrPath}`;
  return `${base}${suffix}`;
}

/** Execute all pages in the spec (navigate, screenshot, scenarios). */
async function executePages(
  spec: Spec,
  page: import('playwright').Page,
  capture: CaptureCollector,
  ctx: HookContext,
  baseUrl: string,
  options: { screenshotOnEveryStep: boolean; stepTimeoutMs: number },
  log: (msg: string) => void,
): Promise<void> {
  for (const pageSpec of spec.pages ?? []) {
    log(`  [page] ${pageSpec.id} — ${pageSpec.path}`);
    const url = resolveUrl(pageSpec.path, baseUrl);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.stepTimeoutMs });
      // Wait a bit for dynamic content
      await page.waitForTimeout(800);
    } catch (err) {
      log(`  [page] ERROR navigating to ${url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Take page screenshot
    await capture.screenshot(page, `page-${pageSpec.id}`);

    // Execute scenarios
    await executePageScenarios(pageSpec, page, capture, ctx, options, log);
  }
}

async function executePageScenarios(
  pageSpec: PageSpec,
  page: import('playwright').Page,
  capture: CaptureCollector,
  ctx: HookContext,
  options: { screenshotOnEveryStep: boolean; stepTimeoutMs: number },
  log: (msg: string) => void,
): Promise<void> {
  for (const scenario of pageSpec.scenarios ?? []) {
    log(`    [scenario] ${scenario.id}`);

    for (const step of scenario.steps) {
      log(`      [step] ${step.action}${step.description ? ` — ${step.description}` : ''}`);
      const result = await executeStep(page, step, capture, ctx, {
        screenshotOnEveryStep: options.screenshotOnEveryStep,
        stepTimeoutMs: options.stepTimeoutMs,
      });

      if (!result.success) {
        log(`      [step] FAILED: ${result.error}`);
        // Continue to next step — don't crash
      } else if (result.evidence) {
        log(`      [step] OK: ${result.evidence}`);
      }
    }
  }
}

/** Execute all flows in the spec. */
async function executeFlows(
  spec: Spec,
  page: import('playwright').Page,
  capture: CaptureCollector,
  ctx: HookContext,
  baseUrl: string,
  options: { screenshotOnEveryStep: boolean; stepTimeoutMs: number },
  log: (msg: string) => void,
): Promise<void> {
  for (const flow of spec.flows ?? []) {
    log(`  [flow] ${flow.id}`);

    for (const step of flow.steps) {
      const stepLabel = 'navigate' in step
        ? `navigate ${step.navigate}`
        : 'assert_page' in step
          ? `assert_page ${step.assert_page}`
          : `action ${(step as { action: string }).action}`;

      log(`    [step] ${stepLabel}`);
      const result = await executeFlowStep(page, step, capture, ctx, baseUrl, {
        screenshotOnEveryStep: options.screenshotOnEveryStep,
        stepTimeoutMs: options.stepTimeoutMs,
      });

      if (!result.success) {
        log(`    [step] FAILED: ${result.error}`);
        // Continue — don't crash the flow
      } else if (result.evidence) {
        log(`    [step] OK: ${result.evidence}`);
      }
    }
  }
}

/** Run the agent: spec → browser execution → capture → gap report. */
export async function runAgent(config: AgentConfig): Promise<AgentRunResult> {
  const log = config.log ?? ((msg: string) => console.log(msg));
  const errors: string[] = [];

  const outputDir = config.outputDir ?? defaultOutputDir(config.specPath);
  const captureDir = path.join(outputDir, 'capture');
  fs.mkdirSync(captureDir, { recursive: true });

  const headless = config.headless ?? true;
  const runSetupHooks = config.hooks?.setup ?? true;
  const runTeardownHooks = config.hooks?.teardown ?? true;
  const screenshotOnEveryStep = config.screenshotOnEveryStep ?? true;
  const overallTimeout = config.timeout ?? 5 * 60 * 1000;
  const stepTimeoutMs = Math.min(15_000, overallTimeout / 10);

  // ---------------------------------------------------------------------------
  // 0. Resume support — load existing captures if resumeDir is set
  // ---------------------------------------------------------------------------
  let resumedTraffic: CapturedTraffic[] = [];
  let resumedConsole: CapturedConsoleEntry[] = [];
  const resumedPages = new Set<string>();

  if (config.resumeDir) {
    log(`[agent] Resuming from ${config.resumeDir}...`);
    const manifestPath = path.join(config.resumeDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const trafficPath = path.join(config.resumeDir, 'traffic.json');
      const consolePath = path.join(config.resumeDir, 'console.json');

      if (fs.existsSync(trafficPath)) {
        resumedTraffic = JSON.parse(fs.readFileSync(trafficPath, 'utf-8')) as CapturedTraffic[];
        log(`[agent] Loaded ${resumedTraffic.length} existing traffic entries`);
        // Determine which pages were already visited from traffic
        for (const entry of resumedTraffic) {
          try {
            const urlPath = new URL(entry.url).pathname;
            resumedPages.add(urlPath);
          } catch {
            // ignore
          }
        }
      }
      if (fs.existsSync(consolePath)) {
        resumedConsole = JSON.parse(fs.readFileSync(consolePath, 'utf-8')) as CapturedConsoleEntry[];
        log(`[agent] Loaded ${resumedConsole.length} existing console entries`);
      }
    } else {
      log(`[agent] No manifest.json found in ${config.resumeDir}, starting fresh`);
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Load spec
  // ---------------------------------------------------------------------------
  log('[agent] Loading spec...');
  const spec = loadSpec(config.specPath);
  log(`[agent] Spec: "${spec.name}" (${spec.pages?.length ?? 0} pages, ${spec.flows?.length ?? 0} flows)`);

  // Variable context
  const ctx: HookContext = {
    specVars: spec.variables ?? {},
    runtimeVars: {},
  };

  // ---------------------------------------------------------------------------
  // 2. Run setup hooks
  // ---------------------------------------------------------------------------
  if (runSetupHooks && spec.hooks?.setup?.length) {
    log(`[agent] Running ${spec.hooks.setup.length} setup hook(s)...`);
    try {
      await executeHooks(spec.hooks.setup, ctx, log);
    } catch (err) {
      const msg = `Setup hooks failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`[agent] WARNING: ${msg}`);
      errors.push(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Launch Playwright
  // ---------------------------------------------------------------------------
  log(`[agent] Launching browser (headless=${headless})...`);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  // Derive host filter from target URL
  let hostFilter = '';
  try {
    hostFilter = new URL(config.targetUrl).hostname;
  } catch {
    // ignore
  }

  const capture = new CaptureCollector({
    outputDir: captureDir,
    targetUrl: config.targetUrl,
    hostFilter,
  });

  try {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();

    // ---------------------------------------------------------------------------
    // 4. Set up traffic interception and console capture
    // ---------------------------------------------------------------------------
    log('[agent] Setting up traffic interception...');
    await capture.attachToContext(context);
    capture.attachToPage(page);

    // ---------------------------------------------------------------------------
    // 5. Execute pages and scenarios (skip pages already captured when resuming)
    // ---------------------------------------------------------------------------
    log('[agent] Executing pages...');
    const specToExecute = resumedPages.size > 0
      ? {
          ...spec,
          pages: (spec.pages ?? []).filter((p) => !resumedPages.has(p.path)),
        }
      : spec;
    if (resumedPages.size > 0) {
      const skipped = (spec.pages ?? []).length - (specToExecute.pages ?? []).length;
      if (skipped > 0) log(`[agent] Skipping ${skipped} page(s) already captured`);
    }
    try {
      await executePages(specToExecute, page, capture, ctx, config.targetUrl, { screenshotOnEveryStep, stepTimeoutMs }, log);
    } catch (err) {
      const msg = `Page execution error: ${err instanceof Error ? err.message : String(err)}`;
      log(`[agent] ERROR: ${msg}`);
      errors.push(msg);
    }

    // ---------------------------------------------------------------------------
    // 5b. Execute flows
    // ---------------------------------------------------------------------------
    if ((spec.flows ?? []).length > 0) {
      log('[agent] Executing flows...');
      try {
        await executeFlows(spec, page, capture, ctx, config.targetUrl, { screenshotOnEveryStep, stepTimeoutMs }, log);
      } catch (err) {
        const msg = `Flow execution error: ${err instanceof Error ? err.message : String(err)}`;
        log(`[agent] ERROR: ${msg}`);
        errors.push(msg);
      }
    }

    await page.close();
  } catch (err) {
    const msg = `Browser execution error: ${err instanceof Error ? err.message : String(err)}`;
    log(`[agent] ERROR: ${msg}`);
    errors.push(msg);
  } finally {
    try {
      await context?.close();
    } catch { /* ignore */ }
    try {
      await browser?.close();
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // 6. Save captures (merge with resumed data if applicable)
  // ---------------------------------------------------------------------------
  // Merge resumed traffic and console logs into the collector before saving
  for (const entry of resumedTraffic) {
    capture.addTraffic(entry);
  }
  // Console logs from resumed sessions are added via addConsoleLogs
  for (const entry of resumedConsole) {
    capture.addConsoleLog(entry);
  }
  log('[agent] Saving captures...');
  capture.save();
  log(`[agent] Captures saved to ${captureDir}`);

  // ---------------------------------------------------------------------------
  // 7. Run validation engine
  // ---------------------------------------------------------------------------
  log('[agent] Running validation engine...');
  let captureData = loadCaptureData(captureDir);
  let report = validate(spec, captureData);
  log(`[agent] Validation: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.untested} untested`);

  // ---------------------------------------------------------------------------
  // 7b. Adaptive exploration (--explore)
  // ---------------------------------------------------------------------------
  if (config.explore && report.summary.untested > 0) {
    const maxRounds = config.maxExplorationRounds ?? 2;
    log(`[agent] Explore mode enabled (max ${maxRounds} rounds)...`);

    for (let round = 1; round <= maxRounds; round++) {
      const strategy = planExploration(spec, report);
      if (strategy.totalUntested === 0) {
        log(`[agent] Exploration round ${round}: nothing left to explore`);
        break;
      }

      log(`[agent] Exploration round ${round}: ${strategy.totalUntested} untested items`);

      // Log what we plan to explore
      for (const target of strategy.untestedPages) {
        log(`  [explore] Unvisited page: ${target.path}`);
      }
      for (const target of strategy.untestedRequests) {
        log(`  [explore] Untested request: ${target.description}`);
      }
      for (const target of strategy.untestedScenarios) {
        log(`  [explore] Untested scenario: ${target.description}`);
      }

      // Launch a new browser session for exploration
      let exploreBrowser: Browser | null = null;
      let exploreContext: BrowserContext | null = null;
      try {
        exploreBrowser = await chromium.launch({ headless });
        exploreContext = await exploreBrowser.newContext({
          viewport: { width: 1440, height: 900 },
        });

        const explorePage = await exploreContext.newPage();
        await capture.attachToContext(exploreContext);
        capture.attachToPage(explorePage);

        // Navigate to each untested page
        const allTargets = [
          ...strategy.untestedPages,
          ...strategy.untestedRequests,
          ...strategy.untestedScenarios,
        ];

        for (const target of allTargets) {
          const url = resolveUrl(target.path, config.targetUrl);
          log(`  [explore] Navigating to ${url}`);
          try {
            await explorePage.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: stepTimeoutMs,
            });
            await explorePage.waitForTimeout(800);
            await capture.screenshot(explorePage, `explore-${target.pageId}`);

            // Execute any interaction steps
            for (const step of target.interactionSteps) {
              try {
                await executeStep(explorePage, step, capture, ctx, {
                  screenshotOnEveryStep,
                  stepTimeoutMs,
                });
              } catch {
                // Continue on step failure
              }
            }
          } catch (err) {
            log(`  [explore] ERROR: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        await explorePage.close();
      } catch (err) {
        const msg = `Exploration error: ${err instanceof Error ? err.message : String(err)}`;
        log(`[agent] ERROR: ${msg}`);
        errors.push(msg);
      } finally {
        try {
          await exploreContext?.close();
        } catch { /* ignore */ }
        try {
          await exploreBrowser?.close();
        } catch { /* ignore */ }
      }

      // Re-save captures and re-validate
      capture.save();
      captureData = loadCaptureData(captureDir);
      report = validate(spec, captureData);
      log(`[agent] After exploration round ${round}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.untested} untested`);

      // Stop if no more untested items
      if (report.summary.untested === 0) break;
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Generate gap reports
  // ---------------------------------------------------------------------------
  const reportMarkdownPath = path.join(outputDir, 'report.md');
  const reportJsonPath = path.join(outputDir, 'report.json');

  fs.writeFileSync(reportMarkdownPath, toMarkdown(report), 'utf-8');
  fs.writeFileSync(reportJsonPath, toJson(report), 'utf-8');
  log(`[agent] Reports saved: report.md, report.json`);

  // ---------------------------------------------------------------------------
  // 9. Run teardown hooks
  // ---------------------------------------------------------------------------
  if (runTeardownHooks && spec.hooks?.teardown?.length) {
    log(`[agent] Running ${spec.hooks.teardown.length} teardown hook(s)...`);
    try {
      await executeHooks(spec.hooks.teardown, ctx, log);
    } catch (err) {
      const msg = `Teardown hooks failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`[agent] WARNING: ${msg}`);
      errors.push(msg);
    }
  }

  log('[agent] Done.');

  return {
    report,
    outputDir,
    reportMarkdownPath,
    reportJsonPath,
    captureDir,
    errors,
  };
}
