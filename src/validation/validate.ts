/**
 * src/validation/validate.ts — CLI entry point for spec validation
 *
 * Usage:
 *   npx tsx src/validation/validate.ts --spec path/to/spec.yaml --capture path/to/capture/dir
 *
 * Options:
 *   --spec <path>     Path to spec file (.yaml, .yml, or .json)
 *   --capture <dir>   Path to capture session directory
 *   --output <dir>    Directory to write report files (default: current directory)
 *   --json-only       Only output JSON, skip Markdown
 *   --md-only         Only output Markdown, skip JSON
 *   --quiet           Suppress stdout output (still writes files if --output given)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more failures
 *   2 — all checks untested (no evidence found)
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadSpec } from '../spec/parser.js';
import { loadCaptureData, validate } from './validator.js';
import { toJson, toMarkdown } from './reporter.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  spec: string;
  capture: string;
  output?: string;
  jsonOnly: boolean;
  mdOnly: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // skip node + script path
  const result: Partial<CliArgs> = {
    jsonOnly: false,
    mdOnly: false,
    quiet: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--spec':
        result.spec = args[++i];
        break;
      case '--capture':
        result.capture = args[++i];
        break;
      case '--output':
        result.output = args[++i];
        break;
      case '--json-only':
        result.jsonOnly = true;
        break;
      case '--md-only':
        result.mdOnly = true;
        break;
      case '--quiet':
        result.quiet = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          printUsage();
          process.exit(1);
        }
    }
  }

  if (!result.spec) {
    console.error('Error: --spec <path> is required');
    printUsage();
    process.exit(1);
  }

  if (!result.capture) {
    console.error('Error: --capture <dir> is required');
    printUsage();
    process.exit(1);
  }

  return result as CliArgs;
}

function printUsage(): void {
  console.log(`
Usage: npx tsx src/validation/validate.ts --spec <path> --capture <dir> [options]

Options:
  --spec <path>     Path to spec file (.yaml, .yml, or .json)
  --capture <dir>   Path to capture session directory
  --output <dir>    Directory to write report files (gap-report.md, gap-report.json)
  --json-only       Only generate JSON output
  --md-only         Only generate Markdown output
  --quiet           Suppress stdout output
  --help, -h        Show this help message

Exit codes:
  0  All checks passed
  1  One or more failures detected
  2  All checks untested (no evidence found in capture)
`.trim());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Load spec
  let spec;
  try {
    spec = loadSpec(args.spec);
  } catch (err) {
    console.error(`Failed to load spec: ${(err as Error).message}`);
    process.exit(1);
  }

  // Load capture
  let capture;
  try {
    capture = loadCaptureData(args.capture);
  } catch (err) {
    console.error(`Failed to load capture data: ${(err as Error).message}`);
    process.exit(1);
  }

  // Run validation
  const report = validate(spec, capture);

  // Generate output formats
  const jsonOutput = args.mdOnly ? null : toJson(report);
  const mdOutput = args.jsonOnly ? null : toMarkdown(report);

  // Print to stdout
  if (!args.quiet) {
    if (mdOutput) {
      console.log(mdOutput);
    } else if (jsonOutput) {
      console.log(jsonOutput);
    }
  }

  // Write to files if --output specified
  if (args.output) {
    const outDir = path.resolve(args.output);
    fs.mkdirSync(outDir, { recursive: true });

    if (jsonOutput) {
      const jsonPath = path.join(outDir, 'gap-report.json');
      fs.writeFileSync(jsonPath, jsonOutput, 'utf-8');
      if (!args.quiet) {
        console.error(`Wrote: ${jsonPath}`);
      }
    }

    if (mdOutput) {
      const mdPath = path.join(outDir, 'gap-report.md');
      fs.writeFileSync(mdPath, mdOutput, 'utf-8');
      if (!args.quiet) {
        console.error(`Wrote: ${mdPath}`);
      }
    }
  }

  // Determine exit code
  const { passed, failed, untested, total } = report.summary;

  if (failed > 0) {
    if (!args.quiet) {
      console.error(
        `\nResult: ${failed} failed, ${passed} passed, ${untested} untested out of ${total} checks`,
      );
    }
    process.exit(1);
  }

  if (passed === 0 && untested === total) {
    if (!args.quiet) {
      console.error(
        `\nResult: all ${total} checks untested — no evidence found in capture`,
      );
    }
    process.exit(2);
  }

  if (!args.quiet) {
    console.error(
      `\nResult: ${passed} passed, ${untested} untested out of ${total} checks`,
    );
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
