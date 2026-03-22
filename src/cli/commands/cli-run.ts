/**
 * src/cli/commands/cli-run.ts — Run CLI verification against a spec
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadSpec, parseSpec } from '../../spec/parser.js';
import { runCliValidation, cliReportToMarkdown } from '../../cli-test/runner.js';
import type { Spec } from '../../spec/types.js';
import { isV1 } from '../../spec/types.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';
import { c } from '../colors.js';
import { readStdin } from '../stdin.js';

export interface CliRunOptions {
  spec: string;
  output?: string;
  historyDir?: string;
}

export async function cliRun(options: CliRunOptions, ctx: CliContext): Promise<number> {
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

  if (!isV1(spec)) {
    process.stderr.write('v2 specs are not supported by this command yet.\n');
    return ExitCode.PARSE_ERROR;
  }

  if (!spec.cli) {
    process.stderr.write('Spec has no cli section.\n');
    return ExitCode.PARSE_ERROR;
  }

  // Run validation
  const result = await runCliValidation({
    spec,
    outputDir: options.output,
    log: ctx.quiet ? undefined : (msg) => process.stderr.write(msg + '\n'),
  });

  const { report } = result;

  // Output
  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    if (!ctx.quiet) process.stdout.write(formatOutput(report, ctx) + '\n');
  } else if (ctx.outputFormat === 'markdown') {
    if (!ctx.quiet) process.stdout.write(cliReportToMarkdown(report) + '\n');
  } else {
    // Text: show markdown to stdout
    if (!ctx.quiet) process.stdout.write(cliReportToMarkdown(report) + '\n');
  }

  // Save to history if --history-dir provided
  if (options.historyDir) {
    const histDir = path.resolve(options.historyDir);
    fs.mkdirSync(histDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const histFile = path.join(histDir, `cli-report-${timestamp}.json`);
    fs.writeFileSync(histFile, JSON.stringify(report, null, 2), 'utf-8');
    if (!ctx.quiet) {
      process.stderr.write(`${c.dim(`History saved: ${histFile}`)}\n`);
    }
  }

  // Summary to stderr
  if (!ctx.quiet) {
    const { summary } = report;
    process.stderr.write(`\n${c.boldGreen(`✓ ${summary.passed} passed`)}  ${summary.failed > 0 ? c.boldRed(`✗ ${summary.failed} failed`) : c.dim(`✗ ${summary.failed} failed`)}  ${c.boldCyan(`${summary.coverage}% coverage`)}\n`);

    // Report behavioral requirement status
    const failedReqs = (report.requirements ?? []).filter(r => r.status === 'failed');
    const verifiedReqs = (report.requirements ?? []).filter(r => r.status === 'verified');
    const failedClaims = (report.claims ?? []).filter(c => c.status === 'failed');
    const passedClaims = (report.claims ?? []).filter(c => c.status === 'passed');
    if (verifiedReqs.length > 0) {
      for (const req of verifiedReqs) {
        const ev = req.evidence as Record<string, unknown> | undefined;
        const method = ev?.method as string | undefined;
        if (method === 'inline_checks') {
          process.stderr.write(`${c.boldGreen('✓')} ${c.bold(req.id)}: ${ev?.checks_passed}/${ev?.checks_run} property check(s) passed\n`);
        } else {
          process.stderr.write(`${c.boldGreen('✓')} ${c.bold(req.id)}: verified by agent\n`);
          process.stderr.write(`  ${c.dim(`Evidence: .specify/evidence/${req.id}.json`)}\n`);
        }
      }
    }
    if (failedReqs.length > 0) {
      const evidenceReqs = failedReqs.filter(r => !r.check_results?.length);
      const checkReqs = failedReqs.filter(r => r.check_results?.length);
      if (checkReqs.length > 0) {
        process.stderr.write(c.boldRed(`\n✗ ${checkReqs.length} requirement(s) failed property checks:\n`));
        for (const req of checkReqs) {
          const failCount = req.check_results?.filter((cr: { status: string }) => cr.status === 'failed').length ?? 0;
          process.stderr.write(`  ${c.red('✗')} ${c.bold(req.id)}: ${failCount} check(s) failed\n`);
        }
      }
      if (evidenceReqs.length > 0) {
        process.stderr.write(c.boldRed(`\n✗ ${evidenceReqs.length} behavioral requirement(s) need agent verification:\n`));
        for (const req of evidenceReqs) {
          process.stderr.write(`  ${c.red('✗')} ${c.bold(req.id)}: ${req.description.slice(0, 100)}${req.description.length > 100 ? '...' : ''}\n`);
        }
        process.stderr.write(c.dim(`  Dispatch an agent to validate these requirements and provide evidence.\n`));
        process.stderr.write(c.dim(`  Evidence goes in: .specify/evidence/<requirement-id>.json\n`));
      }
    }
    if (passedClaims.length > 0) {
      process.stderr.write(c.boldGreen(`\n✓ ${passedClaims.length} grounded claim(s):\n`));
      for (const claim of passedClaims) {
        process.stderr.write(`  ${c.green('✓')} ${c.bold(claim.id)}\n`);
      }
    }
    if (failedClaims.length > 0) {
      process.stderr.write(c.boldRed(`\n✗ ${failedClaims.length} claim(s) are not fully grounded:\n`));
      for (const claim of failedClaims) {
        process.stderr.write(`  ${c.red('✗')} ${c.bold(claim.id)}: ${(claim.reason ?? claim.description).slice(0, 120)}${(claim.reason ?? claim.description).length > 120 ? '...' : ''}\n`);
      }
    }
  }

  if (report.summary.failed > 0) return ExitCode.ASSERTION_FAILURE;
  if (report.summary.passed === 0 && report.summary.untested === report.summary.total) return ExitCode.ALL_UNTESTED;
  return ExitCode.SUCCESS;
}
