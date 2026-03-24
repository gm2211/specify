/**
 * src/cli/commands/impersonate.ts — Impersonate command
 *
 * Captures traffic from a website (or loads a previous capture), optionally
 * generates synthetic data variations via LLM, and spins up a MockServer
 * Docker container that impersonates the original system.
 *
 * Usage:
 *   specify impersonate --url <url> [--port <port>] [--output <dir>] [--no-augment] [--headed]
 *   specify impersonate --capture <dir> [--port <port>] [--output <dir>] [--no-augment]
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';

export interface ImpersonateOptions {
  url?: string;
  capture?: string;
  port?: string;
  output?: string;
  noAugment?: boolean;
  headed?: boolean;
}

export async function impersonateCommand(options: ImpersonateOptions, ctx: CliContext): Promise<number> {
  const log = (msg: string) => {
    if (!ctx.quiet) process.stderr.write(msg + '\n');
  };

  // --- Validate inputs ---

  if (!options.url && !options.capture) {
    const err = {
      error: 'missing_parameter',
      message: 'Provide either --url to capture traffic or --capture to load existing traffic',
    };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const port = options.port ? parseInt(options.port, 10) : 1080;
  if (isNaN(port) || port < 1 || port > 65535) {
    const err = { error: 'invalid_parameter', parameter: '--port', message: 'Port must be a number between 1 and 65535' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const outputDir = path.resolve(options.output || '.specify/impersonate');
  fs.mkdirSync(outputDir, { recursive: true });

  // --- Step 1: Get captured traffic ---

  let captureDir: string;

  if (options.capture) {
    // Load from existing capture directory
    captureDir = path.resolve(options.capture);
    if (!fs.existsSync(path.join(captureDir, 'traffic.json'))) {
      const err = { error: 'missing_file', path: path.join(captureDir, 'traffic.json'), message: 'No traffic.json found in capture directory' };
      process.stdout.write(JSON.stringify(err) + '\n');
      return ExitCode.PARSE_ERROR;
    }
    log(`Loading traffic from ${captureDir}`);
  } else {
    // Run capture first
    const url = options.url!;
    try {
      new URL(url);
    } catch {
      const err = { error: 'invalid_url', url, hint: 'Provide a valid URL (e.g. https://example.com)' };
      process.stdout.write(JSON.stringify(err) + '\n');
      return ExitCode.PARSE_ERROR;
    }

    captureDir = path.join(outputDir, 'capture');
    log(`Capturing traffic from ${url}...`);

    try {
      const { capture } = await import('./capture.js');
      const captureResult = await capture({
        url,
        output: captureDir,
        headed: options.headed,
        noGenerate: true,
      }, { ...ctx, quiet: true });

      if (captureResult !== ExitCode.SUCCESS) {
        log('Capture failed');
        return captureResult;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Capture error: ${msg}`);
      process.stdout.write(JSON.stringify({ error: 'capture_failed', message: msg }) + '\n');
      return ExitCode.BROWSER_ERROR;
    }

    log('Capture complete');
  }

  // --- Step 2: Load traffic ---

  type CapturedTraffic = import('../../capture/types.js').CapturedTraffic;

  let traffic: CapturedTraffic[];
  try {
    const raw = fs.readFileSync(path.join(captureDir, 'traffic.json'), 'utf-8');
    traffic = JSON.parse(raw) as CapturedTraffic[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errObj = { error: 'parse_error', message: `Failed to parse traffic.json: ${msg}` };
    process.stdout.write(JSON.stringify(errObj) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  log(`Loaded ${traffic.length} traffic entries`);

  // --- Step 3: Augment with synthetic data (optional) ---

  let syntheticTraffic: CapturedTraffic[] = [];

  if (!options.noAugment) {
    log('Generating synthetic traffic variations...');

    try {
      const { buildTrafficSummary, getAugmentPrompt, parseSyntheticTraffic } = await import('../../impersonate/augment.js');
      const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');

      const summary = buildTrafficSummary(traffic);
      const augmentPrompt = getAugmentPrompt(summary);

      const agentResult = await runSpecifyAgent({
        task: 'capture',
        systemPrompt: augmentPrompt,
        userPrompt: 'Generate synthetic traffic variations based on the patterns described. Output ONLY a JSON array.',
        outputDir: path.join(outputDir, 'augment'),
      });

      syntheticTraffic = parseSyntheticTraffic(agentResult.result);
      log(`Generated ${syntheticTraffic.length} synthetic traffic entries (cost: $${agentResult.costUsd.toFixed(4)})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Warning: augmentation failed, proceeding with original traffic only: ${msg}`);
    }
  }

  // --- Step 4: Convert to MockServer expectations ---

  const { trafficToExpectations, saveExpectations } = await import('../../impersonate/expectations.js');

  const allTraffic = [...traffic, ...syntheticTraffic];
  const expectations = trafficToExpectations(allTraffic);

  if (expectations.length === 0) {
    log('No expectations generated from traffic (all entries may be static assets)');
    const err = { error: 'no_expectations', message: 'No API expectations could be generated from the captured traffic' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  const expectationsPath = saveExpectations(expectations, outputDir);
  log(`Saved ${expectations.length} expectations to ${expectationsPath}`);

  // --- Step 5: Check Docker ---

  const { checkDockerAvailable, startMockServer, loadExpectations, stopMockServer } = await import('../../impersonate/docker.js');

  const dockerAvailable = await checkDockerAvailable();
  if (!dockerAvailable) {
    const err = { error: 'docker_unavailable', message: 'Docker is not available. Install Docker and ensure the daemon is running.' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.NETWORK_ERROR;
  }

  // --- Step 6: Start MockServer ---

  let containerId: string;
  try {
    log(`Starting MockServer on port ${port}...`);
    containerId = await startMockServer(port);
    log(`MockServer started: container ${containerId.slice(0, 12)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to start MockServer: ${msg}`);
    process.stdout.write(JSON.stringify({ error: 'docker_error', message: msg }) + '\n');
    return ExitCode.NETWORK_ERROR;
  }

  // --- Step 7: Load expectations ---

  try {
    await loadExpectations(port, expectations);
    log(`Loaded ${expectations.length} expectations into MockServer`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to load expectations: ${msg}`);
    await stopMockServer(containerId).catch(() => {});
    process.stdout.write(JSON.stringify({ error: 'expectation_load_failed', message: msg }) + '\n');
    return ExitCode.NETWORK_ERROR;
  }

  // --- Step 8: Output result ---

  const mockServerUrl = `http://localhost:${port}`;

  const result = {
    containerId,
    port,
    expectationCount: expectations.length,
    originalTrafficCount: traffic.length,
    syntheticTrafficCount: syntheticTraffic.length,
    mockServerUrl,
  };

  log('');
  log(`MockServer is impersonating the target at ${mockServerUrl}`);
  log(`  Container:   ${containerId.slice(0, 12)}`);
  log(`  Endpoints:   ${expectations.length} expectations loaded`);
  log(`  Original:    ${traffic.length} captured traffic entries`);
  log(`  Synthetic:   ${syntheticTraffic.length} augmented entries`);
  log('');
  log('Press Ctrl+C to stop the MockServer and exit.');

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  // --- Step 9: Block until SIGINT/SIGTERM ---

  await new Promise<void>(resolve => {
    const shutdown = () => {
      log('\nStopping MockServer...');
      stopMockServer(containerId)
        .then(() => log('MockServer stopped and removed.'))
        .catch((err) => log(`Warning: cleanup failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => resolve());
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  return ExitCode.SUCCESS;
}
