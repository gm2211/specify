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

  const navMap = results?.navMapCoverage;
  const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

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
      {navMap && (
        <div
          className="summary-navmap"
          title={
            navMap.empty
              ? 'No prior navigation map to measure this run against yet.'
              : navMap.summary +
                (navMap.predicateMismatch ? ' (predicate-extractor mismatch — advisory)' : '')
          }
        >
          <span className="summary-navmap-label">Nav map</span>
          {navMap.empty ? (
            <span className="summary-navmap-value summary-navmap-value--empty">no model yet</span>
          ) : (
            <span className="summary-navmap-value">
              states {navMap.states.visited}/{navMap.states.known} ({pct(navMap.states.ratio)}) ·
              transitions {navMap.transitions.visited}/{navMap.transitions.known} (
              {pct(navMap.transitions.ratio)})
              {navMap.predicateMismatch && <span className="summary-navmap-warn"> advisory</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
