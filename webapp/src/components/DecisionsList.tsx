import { useEffect, useState, useCallback } from 'react';
import { listDecisions, resolveDecision, type PendingDecision } from '../api';

const SCOPE_LABELS: Record<string, string> = {
  narrow: 'narrow (this run)',
  medium: 'medium (this behavior)',
  broad: 'broad (all runs)',
};

interface DecisionsListProps {
  onCountChange?: (count: number) => void;
}

export default function DecisionsList({ onCountChange }: DecisionsListProps) {
  const [decisions, setDecisions] = useState<PendingDecision[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const open = await listDecisions('open');
      setDecisions(open);
      onCountChange?.(open.length);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onCountChange]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  // SSE: re-fetch when decisions are filed or resolved
  useEffect(() => {
    const sse = new EventSource('/events/stream');
    sse.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string };
        if (msg.type === 'feedback:decision_filed' || msg.type === 'feedback:decision_resolved') {
          void refresh();
        }
      } catch { /* ignore */ }
    };
    return () => sse.close();
  }, [refresh]);

  const onResolve = async (id: string, resolution_index: number, scope: string): Promise<void> => {
    setBusy(`${id}:${resolution_index}`);
    try {
      await resolveDecision(id, { resolution_index, scope });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (decisions.length === 0 && !error) {
    return <div className="decisions-empty">No open decisions.</div>;
  }

  return (
    <div className="decisions-list">
      {error && <div className="decisions-error">{error}</div>}
      {decisions.map((d) => (
        <div key={d.id} className="decision-card">
          <div className="decision-header">
            <span className="decision-question">{d.question}</span>
            <span className="decision-meta">
              {d.specId} · run {d.runId.slice(0, 8)}
              {d.area_id ? ` · ${d.area_id}` : ''}
              {d.behavior_id ? `/${d.behavior_id}` : ''}
            </span>
          </div>
          <div className="decision-context">{d.context}</div>
          <div className="decision-resolutions">
            {d.proposed_resolutions.map((r, i) => (
              <button
                key={i}
                type="button"
                className={`decision-btn decision-btn--${r.scope}`}
                onClick={() => onResolve(d.id, i, r.scope)}
                disabled={busy === `${d.id}:${i}`}
                title={r.action_hint}
              >
                <span className="decision-btn-scope">{SCOPE_LABELS[r.scope] ?? r.scope}</span>
                <span className="decision-btn-label">{r.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
