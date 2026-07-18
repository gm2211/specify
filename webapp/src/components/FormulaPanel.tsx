import { useEffect, useState } from 'react';
import { approveFormula, fetchFormulas, rejectFormula } from '../api';
import type { FormulaReviewEntry, FormulaWitness } from '../types';

function WitnessBlock({ title, className, witnesses, vacuous, vacuousLabel }: {
  title: string;
  className: string;
  witnesses: FormulaWitness[];
  vacuous: boolean;
  vacuousLabel: string;
}) {
  if (vacuous) {
    return (
      <div className={`formula-witnesses ${className}`}>
        <h5 className="formula-witnesses-title">{title}</h5>
        <div className="formula-witnesses-vacuous">{vacuousLabel}</div>
      </div>
    );
  }
  if (witnesses.length === 0) return null;
  return (
    <div className={`formula-witnesses ${className}`}>
      <h5 className="formula-witnesses-title">{title}</h5>
      {witnesses.map((w, i) => (
        <pre key={i} className="formula-witness">{w.narrative}</pre>
      ))}
    </div>
  );
}

export default function FormulaPanel() {
  const [entries, setEntries] = useState<FormulaReviewEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const formulas = await fetchFormulas();
      setEntries(formulas);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 15000);
    return () => clearInterval(t);
  }, []);

  const onApprove = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await approveFormula(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onReject = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      await rejectFormula(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (entries.length === 0) {
    return null;
  }

  const pending = entries.filter((e) => e.status === 'draft');
  const decided = entries.filter((e) => e.status !== 'draft');

  return (
    <section className="formula-review">
      <button
        type="button"
        className="formula-review-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="formula-review-title">Formula review</span>
        <span className="formula-review-count">
          {pending.length} pending · {decided.filter((e) => e.status === 'approved').length} approved · {decided.filter((e) => e.status === 'rejected').length} rejected
        </span>
        <span className="formula-review-toggle">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="formula-review-body">
          <p className="formula-review-risk-note">
            Approved formulas gate verify verdicts: an approved formula that is violated can force a
            behavior to fail. Review the <strong>examples</strong> below, not the formula&apos;s logic —
            each accepting/rejecting trace shows a plain-English run that this formula would pass or fail.
          </p>
          {error && <div className="formula-review-error">{error}</div>}
          {entries.map((entry) => (
            <div key={entry.id} className="formula-entry">
              <div className="formula-entry-row">
                <button
                  type="button"
                  className="formula-entry-toggle"
                  onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                >
                  {openId === entry.id ? '▼' : '▶'}
                </button>
                <span className="formula-entry-behavior">{entry.behavior}</span>
                <span className={`formula-status-chip formula-status-chip--${entry.status}`}>
                  {entry.status}
                </span>
                {entry.witnesses.vacuousRejecting && (
                  <span className="formula-vacuity-badge" title="This formula can never fail — likely vacuous">
                    vacuous
                  </span>
                )}
                {entry.status === 'draft' && (
                  <>
                    <button
                      type="button"
                      className="formula-entry-approve"
                      onClick={() => onApprove(entry.id)}
                      disabled={busy === entry.id}
                    >
                      {busy === entry.id ? '…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="formula-entry-reject"
                      onClick={() => onReject(entry.id)}
                      disabled={busy === entry.id}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
              {entry.behaviorDescription && (
                <div className="formula-entry-desc">{entry.behaviorDescription}</div>
              )}
              {openId === entry.id && (
                <div className="formula-entry-body">
                  <div className="formula-entry-formula">
                    <code>{entry.prettyFormula}</code>
                  </div>
                  <WitnessBlock
                    title="Accepting examples (would PASS)"
                    className="formula-witnesses--accepting"
                    witnesses={entry.witnesses.accepting}
                    vacuous={entry.witnesses.vacuousAccepting}
                    vacuousLabel="This formula can never be satisfied — likely a contradiction."
                  />
                  <WitnessBlock
                    title="Rejecting examples (would FAIL)"
                    className="formula-witnesses--rejecting"
                    witnesses={entry.witnesses.rejecting}
                    vacuous={entry.witnesses.vacuousRejecting}
                    vacuousLabel="This formula can never fail — likely vacuous. Treat this as a review red flag."
                  />
                  {entry.witnesses.coverage === 'sampled' && (
                    <div className="formula-entry-coverage">
                      Witness search was sampled (large atom alphabet), not exhaustive.
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
