/**
 * src/cli/commands/capture.ts — Standalone capture command
 *
 * Browses to a URL, captures network traffic, console logs, and screenshots,
 * then writes everything to an output directory using CaptureCollector.
 *
 * Usage:
 *   specify capture --url <url> --output <dir> [--headed] [--timeout <ms>] [--no-screenshots]
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { isV1 } from '../../spec/types.js';

type CapturePage = {
  goto(url: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'load', options: { timeout: number }): Promise<void>;
};

export interface CaptureOptions {
  url: string;
  output: string;
  headed?: boolean;
  timeout?: number;
  noScreenshots?: boolean;
  noGenerate?: boolean;
  specOutput?: string;
  specName?: string;
  ignoreHttpsErrors?: boolean;
  human?: boolean;
}

export async function navigateWithLoadFallback(
  page: CapturePage,
  url: string,
  timeout: number,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'TimeoutError') {
      throw err;
    }

    // Busy pages can keep connections open forever after the initial document load.
    log('networkidle timed out, waiting for load on current page...');
    await page.waitForLoadState('load', { timeout });
  }
}

export async function capture(options: CaptureOptions, ctx: CliContext): Promise<number> {
  if (!options.url) {
    const err = { error: 'missing_parameter', parameter: '--url', hint: 'Provide the URL to capture' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  if (!options.output) {
    const err = { error: 'missing_parameter', parameter: '--output', hint: 'Provide an output directory' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const outputDir = path.resolve(options.output);
  const timeout = options.timeout ?? 30_000;

  const log = (msg: string) => {
    if (!ctx.quiet) process.stderr.write(msg + '\n');
  };

  let hostFilter = '';
  try {
    hostFilter = new URL(options.url).hostname;
  } catch {
    const err = { error: 'invalid_url', url: options.url, hint: 'Provide a valid URL (e.g. https://example.com)' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  log(`Capturing ${options.url} → ${outputDir}`);

  const startMs = Date.now();

  // Lazy-import Playwright and CaptureCollector
  const { chromium } = await import('playwright');
  const { CaptureCollector } = await import('../../agent/capture.js');

  const collector = new CaptureCollector({
    outputDir,
    targetUrl: options.url,
    hostFilter,
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: !options.headed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Browser launch failed: ${msg}`);
    process.stdout.write(JSON.stringify({ error: 'browser_error', message: msg }) + '\n');
    return ExitCode.BROWSER_ERROR;
  }

  try {
    // Extract HTTP Basic Auth credentials from URL if present
    const parsedUrl = new URL(options.url);
    const contextOptions: Parameters<typeof browser.newContext>[0] = {
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    };
    let navigateUrl = options.url;
    if (parsedUrl.username) {
      contextOptions.httpCredentials = {
        username: decodeURIComponent(parsedUrl.username),
        password: decodeURIComponent(parsedUrl.password),
      };
      // Strip credentials from the URL for navigation
      parsedUrl.username = '';
      parsedUrl.password = '';
      navigateUrl = parsedUrl.toString();
    }

    const context = await browser.newContext(contextOptions);

    // Attach traffic interception
    await collector.attachToContext(context);

    const page = await context.newPage();

    // Attach console log capture
    collector.attachToPage(page);

    // Navigate
    log(`Navigating to ${navigateUrl}...`);
    try {
      await navigateWithLoadFallback(page, navigateUrl, timeout, log);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Navigation failed: ${msg}`);
      process.stdout.write(JSON.stringify({ error: 'network_error', message: msg }) + '\n');
      return ExitCode.NETWORK_ERROR;
    }

    // Take a screenshot of the loaded page
    if (!options.noScreenshots) {
      await collector.screenshot(page, 'initial');
    }

    if (options.human) {
      // Human mode: keep browser open, let human browse
      log('');
      log('Human capture mode — browse the site in the opened browser.');
      log('All traffic, console logs, and interactions are being recorded.');
      log('Press Enter in this terminal when done...');
      log('');
      await new Promise<void>(resolve => {
        process.stdin.resume();
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
        // Also resolve on stdin end (non-TTY)
        process.stdin.once('end', () => resolve());
      });
      log('Stopping capture...');
    } else {
      // Default passive mode: wait for deferred API calls
      await page.waitForTimeout(2000);
    }

    // Take a post-settle screenshot
    if (!options.noScreenshots) {
      await collector.screenshot(page, 'settled');
    }

    // Save everything
    const manifest = collector.save();
    const durationMs = Date.now() - startMs;

    const summary = {
      directory: outputDir,
      url: options.url,
      timestamp: manifest.session.timestamp,
      totalRequests: manifest.session.totalRequests,
      totalScreenshots: manifest.session.totalScreenshots,
      consoleLogCount: manifest.session.consoleLogCount,
      duration_ms: durationMs,
    };

    log(`Capture complete: ${summary.totalRequests} requests, ${summary.totalScreenshots} screenshots in ${durationMs}ms`);

    // Auto-generate spec from captured data (unless --no-generate)
    if (!options.noGenerate) {
      try {
        const { generateSpecV2 } = await import('../../spec/generator.js');
        const { specToYaml } = await import('../../spec/parser.js');

        const spec = generateSpecV2({
          inputDir: outputDir,
          specName: options.specName ?? new URL(options.url).hostname,
        });

        const specFile = options.specOutput
          ?? path.join(path.dirname(outputDir), 'spec.yaml');
        const resolvedSpecFile = path.resolve(specFile);
        fs.mkdirSync(path.dirname(resolvedSpecFile), { recursive: true });
        fs.writeFileSync(resolvedSpecFile, specToYaml(spec), 'utf-8');
        const areaCount = spec.areas.length;
        const behaviorCount = spec.areas.reduce((n, a) => n + a.behaviors.length, 0);
        log(`Spec generated: ${resolvedSpecFile} (${areaCount} areas, ${behaviorCount} behaviors)`);

        (summary as Record<string, unknown>).spec = resolvedSpecFile;
        (summary as Record<string, unknown>).specAreas = areaCount;
        (summary as Record<string, unknown>).specBehaviors = behaviorCount;
      } catch (err) {
        log(`Warning: spec generation failed: ${(err as Error).message}`);
        log('Run "specify spec generate" manually to generate a spec from the capture data.');
      }
    }

    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return ExitCode.SUCCESS;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Capture failed: ${msg}`);
    process.stdout.write(JSON.stringify({ error: 'browser_error', message: msg }) + '\n');
    return ExitCode.BROWSER_ERROR;
  } finally {
    await browser.close().catch(() => {});
  }
}
