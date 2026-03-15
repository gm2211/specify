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

export interface CaptureOptions {
  url: string;
  output: string;
  headed?: boolean;
  timeout?: number;
  noScreenshots?: boolean;
  noGenerate?: boolean;
  specOutput?: string;
  specName?: string;
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
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    // Attach traffic interception
    await collector.attachToContext(context);

    const page = await context.newPage();

    // Attach console log capture
    collector.attachToPage(page);

    // Navigate
    log(`Navigating to ${options.url}...`);
    try {
      await page.goto(options.url, { waitUntil: 'networkidle', timeout });
    } catch (err) {
      // networkidle can time out on busy pages — fall back to load
      log(`networkidle timed out, waiting for load...`);
      try {
        await page.goto(options.url, { waitUntil: 'load', timeout });
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        log(`Navigation failed: ${msg}`);
        process.stdout.write(JSON.stringify({ error: 'network_error', message: msg }) + '\n');
        return ExitCode.NETWORK_ERROR;
      }
    }

    // Take a screenshot of the loaded page
    if (!options.noScreenshots) {
      await collector.screenshot(page, 'initial');
    }

    // Wait a moment for any deferred API calls to complete
    await page.waitForTimeout(2000);

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
        const { generateSpec } = await import('../../spec/generator.js');
        const { specToYaml } = await import('../../spec/parser.js');

        const spec = generateSpec({
          inputDir: outputDir,
          specName: options.specName ?? new URL(options.url).hostname,
          smart: false,
        });

        const specFile = options.specOutput
          ?? path.join(path.dirname(outputDir), 'spec.yaml');
        const resolvedSpecFile = path.resolve(specFile);
        fs.mkdirSync(path.dirname(resolvedSpecFile), { recursive: true });
        fs.writeFileSync(resolvedSpecFile, specToYaml(spec), 'utf-8');
        log(`Spec generated: ${resolvedSpecFile} (${spec.pages?.length ?? 0} pages)`);

        (summary as Record<string, unknown>).spec = resolvedSpecFile;
        (summary as Record<string, unknown>).specPages = spec.pages?.length ?? 0;
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
