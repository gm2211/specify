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

  const problems = summary.results.filter((result) => !result.ok);
  if (problems.length) {
    lines.push('', 'Not as expected:');
    for (const result of problems) {
      const where = `${result.source.file}:${result.source.line}`;
      lines.push(`- ${result.requirementId} (${where}): ${explain(result)}`);
    }
  }
  if (summary.unlinkedRequirementIds.length) {
    lines.push(
      '',
      `Requirements without a Formal line (${summary.unlinkedRequirementIds.length}):`,
    );
    for (const id of summary.unlinkedRequirementIds) lines.push(`- ${id}`);
  }
  lines.push(
    '',
    summary.results.length
      ? `${summary.totals.ok}/${summary.totals.checks} checks as expected. Results cover the formal models only, not the application.`
      : 'No Formal lines found under any OpenSpec requirement.',
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
