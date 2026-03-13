/**
 * src/cli-test/runner.ts — Orchestrate CLI validation
 *
 * Executes all commands defined in a spec's cli section,
 * validates results, and produces a CliGapReport.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Spec, CliSpec, CliCommandSpec, CliScenarioSpec } from '../spec/types.js';
import type { CliGapReport, CliCommandResult, CliScenarioResult, CliCommandRun } from './types.js';
import { executeCommand } from './executor.js';
import { validateCommandRun } from './validator.js';

export interface CliRunConfig {
  spec: Spec;
  outputDir?: string;
  log?: (msg: string) => void;
}

export interface CliRunResult {
  report: CliGapReport;
  runs: CliCommandRun[];
  outputDir?: string;
}

/** Run all CLI commands from a spec and validate results. */
export async function runCliValidation(config: CliRunConfig): Promise<CliRunResult> {
  const { spec, log } = config;
  const cliSpec = spec.cli;

  if (!cliSpec) {
    throw new Error('Spec has no cli section');
  }

  const allRuns: CliCommandRun[] = [];
  const commandResults: CliCommandResult[] = [];
  const scenarioResults: CliScenarioResult[] = [];

  log?.(`CLI Validation: ${spec.name}`);
  log?.(`Binary: ${cliSpec.binary}`);
  log?.('');

  // Run individual commands
  if (cliSpec.commands?.length) {
    log?.(`Running ${cliSpec.commands.length} command(s)...`);
    for (const cmd of cliSpec.commands) {
      const run = await executeCommand(cmd, cliSpec, log);
      allRuns.push(run);
      const result = validateCommandRun(cmd, run);
      commandResults.push(result);
    }
    log?.('');
  }

  // Run scenarios
  if (cliSpec.scenarios?.length) {
    log?.(`Running ${cliSpec.scenarios.length} scenario(s)...`);
    for (const scenario of cliSpec.scenarios) {
      const result = await runScenario(scenario, cliSpec, allRuns, log);
      scenarioResults.push(result);
    }
    log?.('');
  }

  // Compute summary
  const allResults = [
    ...commandResults,
    ...scenarioResults.flatMap(s => s.steps),
  ];

  let totalChecks = 0;
  let passed = 0;
  let failed = 0;
  let untested = 0;

  for (const result of allResults) {
    // Count exit code + each assertion
    const checks = [
      result.exitCode.status,
      ...result.stdoutAssertions.map(a => a.status),
      ...result.stderrAssertions.map(a => a.status),
    ];
    for (const s of checks) {
      totalChecks++;
      if (s === 'passed') passed++;
      else if (s === 'failed') failed++;
      else untested++;
    }
  }

  const report: CliGapReport = {
    spec: {
      name: spec.name,
      version: spec.version,
      description: spec.description,
    },
    cli: {
      binary: cliSpec.binary,
      timestamp: new Date().toISOString(),
    },
    summary: {
      total: totalChecks,
      passed,
      failed,
      untested,
      coverage: totalChecks > 0 ? Math.round(((passed + failed) / totalChecks) * 100) : 0,
    },
    commands: commandResults,
    scenarios: scenarioResults,
  };

  // Save output
  let outputDir: string | undefined;
  if (config.outputDir) {
    outputDir = path.resolve(config.outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'cli-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'cli-report.md'),
      cliReportToMarkdown(report),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'cli-runs.json'),
      JSON.stringify(allRuns, null, 2),
      'utf-8',
    );
    log?.(`Reports written to: ${outputDir}`);
  }

  return { report, runs: allRuns, outputDir };
}

async function runScenario(
  scenario: CliScenarioSpec,
  cliSpec: CliSpec,
  allRuns: CliCommandRun[],
  log?: (msg: string) => void,
): Promise<CliScenarioResult> {
  log?.(`  Scenario: ${scenario.id}${scenario.description ? ` — ${scenario.description}` : ''}`);

  const stepResults: CliCommandResult[] = [];
  let scenarioFailed = false;

  for (const step of scenario.steps) {
    if (scenarioFailed) {
      // Skip remaining steps after failure
      stepResults.push({
        commandId: step.id,
        description: step.description,
        args: step.args,
        status: 'untested',
        exitCode: { expected: step.expected_exit_code ?? 0, actual: -1, status: 'untested' },
        stdoutAssertions: [],
        stderrAssertions: [],
        durationMs: 0,
        timedOut: false,
      });
      continue;
    }

    const run = await executeCommand(step, cliSpec, log);
    allRuns.push(run);
    const result = validateCommandRun(step, run);
    stepResults.push(result);

    if (result.status === 'failed') {
      scenarioFailed = true;
    }
  }

  const status = stepResults.some(s => s.status === 'failed')
    ? 'failed' as const
    : stepResults.some(s => s.status === 'untested')
      ? 'untested' as const
      : 'passed' as const;

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    status,
    steps: stepResults,
  };
}

// ---------------------------------------------------------------------------
// Markdown reporter
// ---------------------------------------------------------------------------

export function cliReportToMarkdown(report: CliGapReport): string {
  const lines: string[] = [];
  const icon = (s: string) =>
    s === 'passed' ? '✅' : s === 'failed' ? '❌' : '⬜';

  lines.push(`# CLI Validation Report: ${report.spec.name}`);
  lines.push('');
  if (report.spec.description) {
    lines.push(`> ${report.spec.description}`);
    lines.push('');
  }

  lines.push('## Metadata');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Binary | \`${report.cli.binary}\` |`);
  lines.push(`| Timestamp | ${report.cli.timestamp} |`);
  lines.push(`| Spec version | \`${report.spec.version}\` |`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|--------|-------|');
  lines.push(`| ✅ Passed | ${report.summary.passed} |`);
  lines.push(`| ❌ Failed | ${report.summary.failed} |`);
  lines.push(`| ⬜ Untested | ${report.summary.untested} |`);
  lines.push(`| **Total** | **${report.summary.total}** |`);
  lines.push(`| **Coverage** | **${report.summary.coverage}%** |`);
  lines.push('');

  // Commands
  if (report.commands.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Commands');
    lines.push('');
    for (const cmd of report.commands) {
      lines.push(`### ${icon(cmd.status)} \`${cmd.commandId}\``);
      if (cmd.description) lines.push(`> ${cmd.description}`);
      lines.push('');
      lines.push(`**Args:** \`${cmd.args.join(' ')}\` · **Duration:** ${cmd.durationMs}ms`);
      lines.push('');

      // Exit code
      lines.push(`**Exit code:** expected \`${JSON.stringify(cmd.exitCode.expected)}\`, got \`${cmd.exitCode.actual}\` ${icon(cmd.exitCode.status)}`);
      lines.push('');

      // Stdout assertions
      if (cmd.stdoutAssertions.length > 0) {
        lines.push('**stdout assertions:**');
        lines.push('');
        lines.push('| Type | Status | Details |');
        lines.push('|------|--------|---------|');
        for (const a of cmd.stdoutAssertions) {
          const detail = a.reason ?? a.description ?? '—';
          lines.push(`| \`${a.type}\` | ${icon(a.status)} | ${detail} |`);
        }
        lines.push('');
      }

      // Stderr assertions
      if (cmd.stderrAssertions.length > 0) {
        lines.push('**stderr assertions:**');
        lines.push('');
        lines.push('| Type | Status | Details |');
        lines.push('|------|--------|---------|');
        for (const a of cmd.stderrAssertions) {
          const detail = a.reason ?? a.description ?? '—';
          lines.push(`| \`${a.type}\` | ${icon(a.status)} | ${detail} |`);
        }
        lines.push('');
      }
    }
  }

  // Scenarios
  if (report.scenarios.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Scenarios');
    lines.push('');
    for (const sc of report.scenarios) {
      lines.push(`### ${icon(sc.status)} Scenario: \`${sc.scenarioId}\``);
      if (sc.description) lines.push(`> ${sc.description}`);
      lines.push('');

      for (const step of sc.steps) {
        lines.push(`- ${icon(step.status)} \`${step.commandId}\` — \`${step.args.join(' ')}\` (exit ${step.exitCode.actual})`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Generated by Specify CLI validator · ${new Date().toISOString()}_`);
  lines.push('');

  return lines.join('\n');
}
