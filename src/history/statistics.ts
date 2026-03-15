/**
 * src/history/statistics.ts — Statistical confidence for assertions
 *
 * For "always" properties: confidence = 1 - (1/N) where N = consecutive passes
 * For "sometimes" properties: confidence = 1 - (1-p)^N where p = historical pass rate
 */

import type { GapReport, CheckStatus } from '../validation/types.js';
import type { CliGapReport } from '../cli-test/types.js';

export interface AssertionStats {
  assertion: string;
  pageId: string;
  totalRuns: number;
  passed: number;
  failed: number;
  untested: number;
  passRate: number;
  consecutivePasses: number;
  consecutiveFailures: number;
  confidence: number;
  quantifier?: 'always' | 'sometimes';
}

export interface StatsReport {
  totalRuns: number;
  assertions: AssertionStats[];
  overallConfidence: number;
}

/** Detect whether a report is a CLI report or web gap report. */
function isCliReport(report: unknown): report is CliGapReport {
  return typeof report === 'object' && report !== null && 'cli' in report && 'commands' in report;
}

/** Compute statistical confidence from a history of gap reports (web or CLI). */
export function computeStats(reports: (GapReport | CliGapReport)[]): StatsReport {
  if (reports.length === 0) {
    return { totalRuns: 0, assertions: [], overallConfidence: 0 };
  }

  // Collect assertion statuses across all runs
  const assertionHistory = new Map<
    string,
    { pageId: string; statuses: CheckStatus[]; quantifier?: 'always' | 'sometimes' }
  >();

  for (const report of reports) {
    if (isCliReport(report)) {
      // CLI report: extract statuses from command results
      for (const cmd of report.commands) {
        // Exit code check
        const exitKey = `cli:${cmd.commandId}:exit_code`;
        const exitEntry = assertionHistory.get(exitKey) ?? { pageId: 'cli', statuses: [] };
        exitEntry.statuses.push(cmd.exitCode.status);
        assertionHistory.set(exitKey, exitEntry);

        // Stdout assertions
        for (const a of cmd.stdoutAssertions) {
          const key = `cli:${cmd.commandId}:stdout:${a.type}:${a.description ?? ''}`;
          const entry = assertionHistory.get(key) ?? { pageId: 'cli', statuses: [] };
          entry.statuses.push(a.status);
          assertionHistory.set(key, entry);
        }

        // Stderr assertions
        for (const a of cmd.stderrAssertions) {
          const key = `cli:${cmd.commandId}:stderr:${a.type}:${a.description ?? ''}`;
          const entry = assertionHistory.get(key) ?? { pageId: 'cli', statuses: [] };
          entry.statuses.push(a.status);
          assertionHistory.set(key, entry);
        }
      }

      // Scenario steps
      for (const scenario of report.scenarios) {
        for (const step of scenario.steps) {
          const exitKey = `cli:${scenario.scenarioId}:${step.commandId}:exit_code`;
          const exitEntry = assertionHistory.get(exitKey) ?? { pageId: 'cli', statuses: [] };
          exitEntry.statuses.push(step.exitCode.status);
          assertionHistory.set(exitKey, exitEntry);
        }
      }
    } else {
      // Web gap report: extract from pages
      for (const page of (report as GapReport).pages) {
        for (const req of page.requests) {
          const key = `${page.pageId}:request:${req.method}:${req.urlPattern}`;
          const entry = assertionHistory.get(key) ?? {
            pageId: page.pageId,
            statuses: [],
            quantifier: req.quantifier,
          };
          entry.statuses.push(req.status);
          assertionHistory.set(key, entry);
        }

        for (const va of page.visualAssertions) {
          const key = `${page.pageId}:visual:${va.type}:${va.selector ?? ''}`;
          const entry = assertionHistory.get(key) ?? {
            pageId: page.pageId,
            statuses: [],
            quantifier: va.quantifier,
          };
          entry.statuses.push(va.status);
          assertionHistory.set(key, entry);
        }

        for (const ce of page.consoleExpectations) {
          const key = `${page.pageId}:console:${ce.level}`;
          const entry = assertionHistory.get(key) ?? {
            pageId: page.pageId,
            statuses: [],
            quantifier: ce.quantifier,
          };
          entry.statuses.push(ce.status);
          assertionHistory.set(key, entry);
        }
      }
    }
  }

  // Calculate stats for each assertion
  const assertions: AssertionStats[] = [];

  for (const [key, { pageId, statuses, quantifier }] of assertionHistory.entries()) {
    const total = statuses.length;
    const passed = statuses.filter(s => s === 'passed').length;
    const failed = statuses.filter(s => s === 'failed').length;
    const untested = statuses.filter(s => s === 'untested').length;
    const testedCount = passed + failed;
    const passRate = testedCount > 0 ? passed / testedCount : 0;

    // Consecutive passes/failures from the end
    let consecutivePasses = 0;
    for (let i = statuses.length - 1; i >= 0; i--) {
      if (statuses[i] === 'passed') consecutivePasses++;
      else break;
    }

    let consecutiveFailures = 0;
    for (let i = statuses.length - 1; i >= 0; i--) {
      if (statuses[i] === 'failed') consecutiveFailures++;
      else break;
    }

    // Confidence calculation
    let confidence: number;
    if (quantifier === 'sometimes') {
      // For "sometimes": confidence = 1 - (1-p)^N
      confidence = testedCount > 0 ? 1 - Math.pow(1 - passRate, testedCount) : 0;
    } else {
      // For "always" (default): confidence = 1 - (1/N) where N = consecutive passes
      confidence = consecutivePasses > 0 ? 1 - 1 / consecutivePasses : 0;
    }

    assertions.push({
      assertion: key,
      pageId,
      totalRuns: total,
      passed,
      failed,
      untested,
      passRate: Math.round(passRate * 1000) / 1000,
      consecutivePasses,
      consecutiveFailures,
      confidence: Math.round(confidence * 1000) / 1000,
      quantifier,
    });
  }

  // Overall confidence: average of all assertion confidences
  const overallConfidence =
    assertions.length > 0
      ? Math.round(
          (assertions.reduce((sum, a) => sum + a.confidence, 0) / assertions.length) * 1000,
        ) / 1000
      : 0;

  return {
    totalRuns: reports.length,
    assertions,
    overallConfidence,
  };
}

/** Format stats as Markdown. */
export function statsToMarkdown(stats: StatsReport): string {
  const lines: string[] = [];

  lines.push('# Statistical Confidence Report');
  lines.push('');
  lines.push(`**Total Runs:** ${stats.totalRuns}`);
  lines.push(`**Overall Confidence:** ${(stats.overallConfidence * 100).toFixed(1)}%`);
  lines.push('');

  if (stats.assertions.length > 0) {
    lines.push('## Assertions');
    lines.push('');
    lines.push('| Assertion | Page | Pass Rate | Confidence | Runs |');
    lines.push('|-----------|------|-----------|------------|------|');

    const sorted = [...stats.assertions].sort((a, b) => a.confidence - b.confidence);
    for (const a of sorted) {
      lines.push(
        `| \`${truncate(a.assertion, 50)}\` | \`${a.pageId}\` | ${(a.passRate * 100).toFixed(1)}% | ${(a.confidence * 100).toFixed(1)}% | ${a.totalRuns} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
