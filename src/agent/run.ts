/**
 * src/agent/run.ts — CLI entry point for the agent runner
 *
 * Usage:
 *   npx tsx src/agent/run.ts --spec path/to/spec.yaml --url https://myapp.com [--headed] [--output ./results]
 *
 * Options:
 *   --spec <path>      Path to spec YAML/JSON (required)
 *   --url <url>        Target base URL to test against (required)
 *   --headed           Run browser in headed mode (default: headless)
 *   --output <dir>     Output directory for captures and reports
 *   --no-setup         Skip setup hooks
 *   --no-teardown      Skip teardown hooks
 *   --timeout <ms>     Overall timeout in milliseconds (default: 300000)
 *   --no-screenshots   Disable per-step screenshots
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — failures found in gap report
 *   2 — errors during execution (browser crashes, hook failures, etc.)
 */

import { runAgent } from './runner.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  specPath: string | null;
  targetUrl: string | null;
  headless: boolean;
  outputDir: string | null;
  runSetup: boolean;
  runTeardown: boolean;
  timeout: number;
  screenshotOnEveryStep: boolean;
} {
  const result = {
    specPath: null as string | null,
    targetUrl: null as string | null,
    headless: true,
    outputDir: null as string | null,
    runSetup: true,
    runTeardown: true,
    timeout: 300_000,
    screenshotOnEveryStep: true,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--spec':
        result.specPath = args[++i] ?? null;
        break;
      case '--url':
        result.targetUrl = args[++i] ?? null;
        break;
      case '--headed':
        result.headless = false;
        break;
      case '--output':
        result.outputDir = args[++i] ?? null;
        break;
      case '--no-setup':
        result.runSetup = false;
        break;
      case '--no-teardown':
        result.runTeardown = false;
        break;
      case '--timeout': {
        const t = parseInt(args[++i] ?? '', 10);
        if (!isNaN(t)) result.timeout = t;
        break;
      }
      case '--no-screenshots':
        result.screenshotOnEveryStep = false;
        break;
      default:
        break;
    }
    i++;
  }

  return result;
}

function printHelp(): void {
  console.log(`
Specify Agent Runner — autonomous spec-driven functional verification

Usage:
  npx tsx src/agent/run.ts --spec <path> --url <url> [options]

Required:
  --spec <path>        Path to spec YAML/JSON
  --url <url>          Target base URL to test against

Options:
  --headed             Run browser in headed (visible) mode
  --output <dir>       Output directory for captures and reports
  --no-setup           Skip setup hooks
  --no-teardown        Skip teardown hooks
  --timeout <ms>       Overall timeout in milliseconds (default: 300000)
  --no-screenshots     Disable per-step screenshots

Exit codes:
  0  All checks passed
  1  Failures found in gap report
  2  Errors during execution
`.trim());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const parsed = parseArgs(args);

  if (!parsed.specPath) {
    console.error('ERROR: --spec <path> is required');
    console.error('Run with --help for usage information.');
    process.exit(2);
  }

  if (!parsed.targetUrl) {
    console.error('ERROR: --url <url> is required');
    console.error('Run with --help for usage information.');
    process.exit(2);
  }

  const config = {
    specPath: parsed.specPath,
    targetUrl: parsed.targetUrl,
    headless: parsed.headless,
    ...(parsed.outputDir ? { outputDir: parsed.outputDir } : {}),
    hooks: {
      setup: parsed.runSetup,
      teardown: parsed.runTeardown,
    },
    timeout: parsed.timeout,
    screenshotOnEveryStep: parsed.screenshotOnEveryStep,
    log: (msg: string) => console.log(msg),
  };

  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  Specify — Agent Runner                                      │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log(`│  Spec:   ${parsed.specPath.substring(0, 52).padEnd(52)} │`);
  console.log(`│  URL:    ${parsed.targetUrl.substring(0, 52).padEnd(52)} │`);
  console.log(`│  Mode:   ${(parsed.headless ? 'headless' : 'headed').padEnd(52)} │`);
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log('');

  let result;
  try {
    result = await runAgent(config);
  } catch (err) {
    console.error('');
    console.error('FATAL ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const { report, outputDir, reportMarkdownPath, reportJsonPath, errors } = result;

  // Print summary
  console.log('');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  Run Complete                                                 │');
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log(`│  Passed:   ${String(report.summary.passed).padEnd(49)} │`);
  console.log(`│  Failed:   ${String(report.summary.failed).padEnd(49)} │`);
  console.log(`│  Untested: ${String(report.summary.untested).padEnd(49)} │`);
  console.log(`│  Coverage: ${String(report.summary.coverage + '%').padEnd(49)} │`);
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log(`│  Output:   ${outputDir.substring(0, 49).padEnd(49)} │`);
  console.log(`│  Report:   ${reportMarkdownPath.substring(0, 49).padEnd(49)} │`);
  console.log(`│  JSON:     ${reportJsonPath.substring(0, 49).padEnd(49)} │`);
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log('');

  if (errors.length > 0) {
    console.error('Execution errors:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    console.error('');
  }

  // Exit code
  if (errors.length > 0) {
    process.exit(2);
  } else if (report.summary.failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
