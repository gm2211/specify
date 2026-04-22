import type { Spec, VerifyResults } from '../types';

interface SummaryProps {
  spec: Spec;
  results: VerifyResults | null;
}

export default function Summary({ spec, results }: SummaryProps) {
  const total = spec.areas.reduce((sum, a) => sum + a.behaviors.length, 0);
  const passed = results?.summary?.passed ?? 0;
  const failed = results?.summary?.failed ?? 0;
  const skipped = results?.summary?.skipped ?? 0;
  const untested = total - passed - failed - skipped;
  const coverage = total > 0 ? Math.round(((passed + failed) / total) * 100) : 0;

  return (
    <div className="summary">
      <div className="summary-badges">
        <span className="badge badge--total">{total} total</span>
        {passed > 0 && <span className="badge badge--passed">{passed} passed</span>}
        {failed > 0 && <span className="badge badge--failed">{failed} failed</span>}
        {skipped > 0 && <span className="badge badge--skipped">{skipped} skipped</span>}
        {untested > 0 && <span className="badge badge--untested">{untested} untested</span>}
      </div>
      <div className="summary-coverage">
        <span className="summary-coverage-label">Coverage</span>
        <span className="summary-coverage-value">{coverage}%</span>
      </div>
    </div>
  );
}
