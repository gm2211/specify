import { useEffect, useState } from 'react';
import { approveSkillDraft, fetchActiveSkills, fetchSkillDrafts, rejectSkillDraft, type SkillDraft } from '../api';

interface ActiveSkill {
  name: string;
  filePath: string;
  description: string;
}

export default function SkillDraftsPanel() {
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [active, setActive] = useState<ActiveSkill[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const [d, a] = await Promise.all([fetchSkillDrafts(), fetchActiveSkills()]);
      setDrafts(d.filter((x) => x.status === 'pending'));
      setActive(a);
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
      await approveSkillDraft(id);
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
      await rejectSkillDraft(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (drafts.length === 0 && active.length === 0) {
    return null;
  }

  return (
    <section className="skill-drafts">
      <button
        type="button"
        className="skill-drafts-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="skill-drafts-title">Learned skills</span>
        <span className="skill-drafts-count">
          {drafts.length} pending · {active.length} approved
        </span>
        <span className="skill-drafts-toggle">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="skill-drafts-body">
          {error && <div className="skill-drafts-error">{error}</div>}
          {drafts.length > 0 && (
            <>
              <h4 className="skill-drafts-section">Pending review</h4>
              {drafts.map((d) => (
                <div key={d.id} className="skill-draft">
                  <div className="skill-draft-row">
                    <button
                      type="button"
                      className="skill-draft-toggle"
                      onClick={() => setOpenId(openId === d.id ? null : d.id)}
                    >
                      {openId === d.id ? '▼' : '▶'}
                    </button>
                    <span className="skill-draft-name">{d.skill.name}</span>
                    <span className="skill-draft-meta">{d.pattern.sessionCount}× sessions, {d.pattern.occurrences}× occurrences</span>
                    <button
                      type="button"
                      className="skill-draft-approve"
                      onClick={() => onApprove(d.id)}
                      disabled={busy === d.id}
                    >
                      {busy === d.id ? '…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="skill-draft-reject"
                      onClick={() => onReject(d.id)}
                      disabled={busy === d.id}
                    >
                      Reject
                    </button>
                  </div>
                  <div className="skill-draft-desc">{d.skill.description}</div>
                  {openId === d.id && (
                    <div className="skill-draft-body">
                      <div className="skill-draft-signature">
                        <code>{d.pattern.signature}</code>
                      </div>
                      <pre>{d.skill.body}</pre>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
          {active.length > 0 && (
            <>
              <h4 className="skill-drafts-section">Approved (replayed in future runs)</h4>
              {active.map((s) => (
                <div key={s.name} className="skill-active">
                  <span className="skill-active-name">{s.name}</span>
                  <span className="skill-active-desc">{s.description}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
