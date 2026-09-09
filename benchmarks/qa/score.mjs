import { claims, defects } from './fixture.mjs';

// Missing/duplicate IDs are untested, never a pass or a detected defect.
export function score(output, buggy) {
  const results = Array.isArray(output?.results) ? output.results : [];
  const rows = claims.map(([id]) => {
    const matches = results.filter((row) => row.id === id);
    const status =
      matches.length === 1 && ['passed', 'failed', 'skipped'].includes(matches[0].status)
        ? matches[0].status
        : 'missing';
    const expected = buggy && defects.has(id) ? 'failed' : 'passed';
    return {
      id,
      expected,
      status,
      evidenceItems:
        matches.length === 1 && Array.isArray(matches[0].evidence) ? matches[0].evidence.length : 0,
    };
  });
  return {
    rows,
    detected: rows.filter((r) => r.expected === 'failed' && r.status === 'failed').length,
    defects: rows.filter((r) => r.expected === 'failed').length,
    falsePositives: rows.filter((r) => r.expected === 'passed' && r.status === 'failed').length,
    healthy: rows.filter((r) => r.expected === 'passed').length,
    missed: rows.filter((r) => r.expected === 'failed' && r.status !== 'failed').length,
    untested: rows.filter((r) => ['missing', 'skipped'].includes(r.status)).length,
    unexpectedIds: results.filter((r) => !claims.some(([id]) => r.id === id)).map((r) => r.id),
  };
}
