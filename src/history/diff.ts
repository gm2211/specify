/**
 * src/history/diff.ts — Gap report diffing for regression detection
 *
 * Compares two GapReports to identify new failures, resolved issues,
 * ongoing problems, and rare/flaky findings.
 */

import type { GapReport, CheckStatus } from '../validation/types.js';

export interface ReportDiff {
  /** Assertions that failed in B but passed/untested in A */
  new_failures: DiffEntry[];
  /** Assertions that passed in B but failed in A */
  resolved: DiffEntry[];
  /** Assertions that failed in both A and B */
  ongoing: DiffEntry[];
  /** Assertions with inconsistent results (flaky) */
  rare: DiffEntry[];
  summary: {
    new_failures: number;
    resolved: number;
    ongoing: number;
    rare: number;
  };
}

export interface DiffEntry {
  pageId: string;
  path: string;
  assertion: string;
  statusA: CheckStatus;
  statusB: CheckStatus;
  finding_type: 'new' | 'resolved' | 'ongoing' | 'rare';
  reason?: string;
}

/** Diff two GapReports: A is the baseline, B is the new report. */
export function diffReports(a: GapReport, b: GapReport): ReportDiff {
  const entries: DiffEntry[] = [];

  // Build lookup for report A
  const aMap = buildAssertionMap(a);
  const bMap = buildAssertionMap(b);

  // Compare all assertions in B against A
  for (const [key, bEntry] of bMap.entries()) {
    const aEntry = aMap.get(key);
    const statusA = aEntry?.status ?? 'untested';
    const statusB = bEntry.status;

    let finding_type: DiffEntry['finding_type'];

    if (statusB === 'failed' && statusA !== 'failed') {
      finding_type = 'new';
    } else if (statusB !== 'failed' && statusA === 'failed') {
      finding_type = 'resolved';
    } else if (statusB === 'failed' && statusA === 'failed') {
      finding_type = 'ongoing';
    } else {
      continue; // Both passing or both untested — skip
    }

    entries.push({
      pageId: bEntry.pageId,
      path: bEntry.path,
      assertion: key,
      statusA,
      statusB,
      finding_type,
      reason: bEntry.reason,
    });
  }

  // Check for assertions that exist in A but not B (rare/removed)
  for (const [key, aEntry] of aMap.entries()) {
    if (!bMap.has(key) && aEntry.status === 'failed') {
      entries.push({
        pageId: aEntry.pageId,
        path: aEntry.path,
        assertion: key,
        statusA: aEntry.status,
        statusB: 'untested',
        finding_type: 'rare',
        reason: 'Assertion present in baseline but not in new report',
      });
    }
  }

  return {
    new_failures: entries.filter(e => e.finding_type === 'new'),
    resolved: entries.filter(e => e.finding_type === 'resolved'),
    ongoing: entries.filter(e => e.finding_type === 'ongoing'),
    rare: entries.filter(e => e.finding_type === 'rare'),
    summary: {
      new_failures: entries.filter(e => e.finding_type === 'new').length,
      resolved: entries.filter(e => e.finding_type === 'resolved').length,
      ongoing: entries.filter(e => e.finding_type === 'ongoing').length,
      rare: entries.filter(e => e.finding_type === 'rare').length,
    },
  };
}

interface AssertionEntry {
  pageId: string;
  path: string;
  status: CheckStatus;
  reason?: string;
}

function buildAssertionMap(report: GapReport): Map<string, AssertionEntry> {
  const map = new Map<string, AssertionEntry>();

  for (const page of report.pages) {
    // Request assertions
    for (const req of page.requests) {
      const key = `${page.pageId}:request:${req.method}:${req.urlPattern}`;
      map.set(key, { pageId: page.pageId, path: page.path, status: req.status, reason: req.reason });
    }

    // Visual assertions
    for (const va of page.visualAssertions) {
      const key = `${page.pageId}:visual:${va.type}:${va.selector ?? ''}`;
      map.set(key, { pageId: page.pageId, path: page.path, status: va.status, reason: va.reason });
    }

    // Console expectations
    for (const ce of page.consoleExpectations) {
      const key = `${page.pageId}:console:${ce.level}`;
      map.set(key, { pageId: page.pageId, path: page.path, status: ce.status, reason: ce.reason });
    }

    // Scenario steps
    for (const sc of page.scenarios) {
      for (let i = 0; i < sc.steps.length; i++) {
        const step = sc.steps[i];
        const key = `${page.pageId}:scenario:${sc.scenarioId}:${i}:${step.action}`;
        map.set(key, { pageId: page.pageId, path: page.path, status: step.status, reason: step.reason });
      }
    }
  }

  // Flow steps
  for (const flow of report.flows) {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const key = `flow:${flow.flowId}:${i}:${step.type}`;
      map.set(key, { pageId: flow.flowId, path: '', status: step.status, reason: step.reason });
    }
  }

  return map;
}

/** Format a ReportDiff as a Markdown string. */
export function diffToMarkdown(diff: ReportDiff): string {
  const lines: string[] = [];

  lines.push('# Report Diff');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|----------|-------|');
  lines.push(`| New Failures | ${diff.summary.new_failures} |`);
  lines.push(`| Resolved | ${diff.summary.resolved} |`);
  lines.push(`| Ongoing | ${diff.summary.ongoing} |`);
  lines.push(`| Rare/Flaky | ${diff.summary.rare} |`);
  lines.push('');

  if (diff.new_failures.length > 0) {
    lines.push('## New Failures');
    lines.push('');
    for (const entry of diff.new_failures) {
      lines.push(`- **${entry.assertion}** (page: \`${entry.pageId}\`)`);
      if (entry.reason) lines.push(`  > ${entry.reason}`);
    }
    lines.push('');
  }

  if (diff.resolved.length > 0) {
    lines.push('## Resolved');
    lines.push('');
    for (const entry of diff.resolved) {
      lines.push(`- **${entry.assertion}** (page: \`${entry.pageId}\`)`);
    }
    lines.push('');
  }

  if (diff.ongoing.length > 0) {
    lines.push('## Ongoing Failures');
    lines.push('');
    for (const entry of diff.ongoing) {
      lines.push(`- **${entry.assertion}** (page: \`${entry.pageId}\`)`);
      if (entry.reason) lines.push(`  > ${entry.reason}`);
    }
    lines.push('');
  }

  if (diff.rare.length > 0) {
    lines.push('## Rare / Flaky');
    lines.push('');
    for (const entry of diff.rare) {
      lines.push(`- **${entry.assertion}** (page: \`${entry.pageId}\`)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
