/**
 * src/cli/commands/spec-sync.ts — Bidirectional spec ↔ test comparison
 *
 * Runs the test analyzer + sync engine and outputs a SyncReport.
 * Exit code 0 if fully synced, 1 if gaps exist.
 */

import * as path from 'path';
import { loadSpec, parseSpec } from '../../spec/parser.js';
import { analyzeTestDirectory } from '../../e2e/test-analyzer.js';
import { computeSync } from '../../e2e/sync-engine.js';
import type { Spec } from '../../spec/types.js';
import type { TestFramework, SyncReport } from '../../e2e/types.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';
import { readStdin } from '../stdin.js';

export interface SpecSyncOptions {
  spec: string;
  tests: string;
  framework?: string;
}

export async function specSync(options: SpecSyncOptions, ctx: CliContext): Promise<number> {
  // Load spec
  let spec: Spec;
  try {
    if (options.spec === '-') {
      const input = await readStdin();
      spec = parseSpec(input);
    } else {
      spec = loadSpec(options.spec);
    }
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Analyze tests
  const framework = (options.framework as TestFramework) ?? undefined;
  const testsDir = path.resolve(options.tests);
  const allAnalyses = analyzeTestDirectory(testsDir, framework);

  // Filter to recognized test files (Playwright or Cypress, not unknown)
  const analyses = allAnalyses.filter(a => a.framework !== 'unknown');

  if (analyses.length === 0) {
    process.stderr.write(`No test files found in: ${testsDir}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Compute sync
  const report = computeSync(spec, analyses);

  // Output
  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    if (!ctx.quiet) process.stdout.write(formatOutput(report, ctx) + '\n');
  } else {
    // Human-readable summary
    if (!ctx.quiet) {
      process.stderr.write(syncReportToText(report) + '\n');
    }
    // Always output JSON to stdout
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  // Exit code: 0 if synced, 1 if gaps
  return (report.summary.uncoveredSpecItems > 0 || report.summary.mismatches > 0)
    ? ExitCode.ASSERTION_FAILURE
    : ExitCode.SUCCESS;
}

function syncReportToText(report: SyncReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push('');
  lines.push(`Sync Report`);
  lines.push(`───────────`);
  lines.push(`  Spec items:   ${summary.totalSpecItems}`);
  lines.push(`  Tests:        ${summary.totalTests}`);
  lines.push(`  Matched:      ${summary.matched}`);
  lines.push(`  Uncovered:    ${summary.uncoveredSpecItems}`);
  lines.push(`  Unmapped:     ${summary.unmappedTests}`);
  lines.push(`  Mismatches:   ${summary.mismatches}`);
  lines.push(`  Sync:         ${summary.syncPercentage}%`);

  if (report.uncoveredSpecItems.length > 0) {
    lines.push('');
    lines.push(`Uncovered spec items:`);
    for (const item of report.uncoveredSpecItems) {
      lines.push(`  - [${item.type}] ${item.specId}: ${item.context}`);
    }
  }

  if (report.unmappedTests.length > 0) {
    lines.push('');
    lines.push(`Unmapped tests:`);
    for (const test of report.unmappedTests) {
      lines.push(`  - ${test.testName} (${path.relative(process.cwd(), test.filePath)})`);
    }
  }

  if (report.mismatches.length > 0) {
    lines.push('');
    lines.push(`Mismatches:`);
    for (const m of report.mismatches) {
      lines.push(`  - ${m.specId} ↔ ${m.testName}:`);
      for (const d of m.differences) {
        lines.push(`      ${d}`);
      }
    }
  }

  return lines.join('\n');
}
