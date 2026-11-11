import type { GateSummary } from './gate.js';
import type { FormalCheckResult, FormalCheckSummary } from './types.js';

/** Render the requirement → result table shown for text and markdown output. */
export function formatReport(summary: FormalCheckSummary): string {
  const header = ['Requirement', 'Check', 'Expect', 'Result', ''];
  const rows = summary.results.map((result) => [
    result.requirementId,
    describeCheck(result),
    result.check?.expect ?? '-',
    result.outcome.status,
    result.ok ? '✓' : '✗',
  ]);
  const lines = [row(header), row(header.map(() => '---')), ...rows.map((cells) => row(cells))];

  lines.push(...problemLines(summary.results));
  if (summary.unlinkedRequirementIds.length) {
    lines.push(
      '',
      `Requirements without a Formal line (${summary.unlinkedRequirementIds.length}):`,
    );
    for (const id of summary.unlinkedRequirementIds) lines.push(`- ${id}`);
  }
  if (summary.waivers.length) {
    lines.push('', `Requirements waived with "Formal: none" (${summary.waivers.length}).`);
  }
  lines.push(
    '',
    summary.results.length
      ? `${summary.totals.ok}/${summary.totals.checks} checks as expected. Results cover the formal models only, not the application.`
      : 'No Formal lines found under any OpenSpec requirement.',
  );
  return lines.join('\n');
}

/** Failed checks with their source line and, when the tool printed one, the counterexample. */
function problemLines(results: FormalCheckResult[]): string[] {
  const problems = results.filter((result) => !result.ok);
  if (!problems.length) return [];
  const lines = ['', 'Not as expected:'];
  for (const result of problems) {
    const where = `${result.source.file}:${result.source.line}`;
    lines.push(`- ${result.requirementId} (${where}): ${explain(result)}`);
    if (result.outcome.trace && result.check?.expect === 'holds') {
      lines.push('', ...result.outcome.trace.split('\n').map((line) => `      ${line}`), '');
    }
  }
  return lines;
}

/** Render the gate verdict: one row per requirement, then every reason the gate is closed. */
export function formatGate(summary: GateSummary): string {
  const header = ['Requirement', 'Model', 'Before model', 'Test'];
  const lines = [
    row(header),
    row(header.map(() => '---')),
    ...summary.matrix.map((entry) =>
      row([entry.requirementId, entry.model, entry.before, entry.test]),
    ),
  ];
  lines.push(...problemLines(summary.results));
  const uncovered = summary.lock.weakenings.filter((weakening) => !weakening.covered);
  const covered = summary.lock.weakenings.length - uncovered.length;
  if (covered) {
    lines.push('', `${covered} property changes are covered by an OpenSpec change proposal.`);
  }
  if (summary.failures.length) {
    lines.push('', `Gate closed (${summary.failures.length}):`);
    for (const failure of summary.failures) lines.push(`- ${failure}`);
  }
  if (summary.warnings.length) {
    lines.push('', `Warnings (${summary.warnings.length}, policy ${summary.policy}):`);
    for (const warning of summary.warnings) lines.push(`- ${warning}`);
  }
  const skipped = summary.skippedChecks
    ? `, ${summary.skippedChecks} unchanged checks skipped`
    : '';
  lines.push(
    '',
    `${summary.valid ? 'Gate open' : 'Gate closed'}: ${summary.totals.ok}/${summary.totals.checks} checks as expected${skipped}, ${summary.waivers.length} waived, policy ${summary.policy}. Results cover the formal models only, not the application.`,
  );
  return lines.join('\n');
}

function describeCheck(result: FormalCheckResult): string {
  const check = result.check;
  if (!check) return 'invalid Formal line';
  if (check.tool === 'lean') return `lean ${check.property}`;
  const backend = check.mode === 'simulate' ? 'simulate' : check.backend;
  const main = check.main ? ` in ${check.main}` : '';
  return `quint ${check.property}${main} (${check.kind}, ${backend})`;
}

function explain(result: FormalCheckResult): string {
  const { outcome, check } = result;
  if (check && (outcome.status === 'holds' || outcome.status === 'fails')) {
    return check.expect === 'fails'
      ? 'expected a counterexample, but the property holds; the "before" model no longer shows the bug'
      : (outcome.message ?? 'property does not hold');
  }
  return outcome.message ?? outcome.status;
}

function row(cells: string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`;
}
