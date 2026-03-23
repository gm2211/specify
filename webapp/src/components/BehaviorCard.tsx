import { useState } from 'react';
import type { Behavior, BehaviorResult } from '../types';

interface BehaviorCardProps {
  areaId: string;
  behavior: Behavior;
  result?: BehaviorResult;
  onVerify: () => void;
  verifying: boolean;
  onEdit: (newDescription: string) => void;
}

export default function BehaviorCard({
  behavior,
  result,
  onVerify,
  verifying,
  onEdit,
}: BehaviorCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(behavior.description);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const status = result?.status ?? 'untested';

  const handleSave = () => {
    if (editText.trim() && editText !== behavior.description) {
      onEdit(editText.trim());
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditText(behavior.description);
    setEditing(false);
  };

  return (
    <div className={`behavior-card behavior-card--${status}`}>
      <div className="behavior-card-header">
        <span className={`status-dot status-dot--${status}`} />
        <span className="behavior-id">{behavior.id}</span>
        <span className={`status-badge status-badge--${status}`}>{status}</span>
      </div>

      {editing ? (
        <div className="behavior-edit">
          <textarea
            className="behavior-edit-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={3}
          />
          <div className="behavior-edit-actions">
            <button className="btn btn--sm btn--primary" onClick={handleSave}>Save</button>
            <button className="btn btn--sm btn--ghost" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <p className="behavior-description">{behavior.description}</p>
      )}

      {behavior.details && (
        <p className="behavior-details">{behavior.details}</p>
      )}

      {behavior.tags && behavior.tags.length > 0 && (
        <div className="behavior-tags">
          {behavior.tags.map((tag) => (
            <span key={tag} className="tag-chip tag-chip--small">{tag}</span>
          ))}
        </div>
      )}

      {result?.rationale && (
        <p className="behavior-rationale">{result.rationale}</p>
      )}

      {result?.evidence && result.evidence.length > 0 && (
        <div className="behavior-evidence">
          <button
            className="evidence-toggle"
            onClick={() => setEvidenceOpen(!evidenceOpen)}
          >
            <svg
              className={`evidence-chevron ${evidenceOpen ? 'evidence-chevron--open' : ''}`}
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="currentColor"
            >
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
            Evidence ({result.evidence.length})
          </button>
          {evidenceOpen && (
            <div className="evidence-list">
              {result.evidence.map((ev, i) => (
                <div key={i} className="evidence-item">
                  <div className="evidence-label">
                    <span className="evidence-type">{ev.type}</span>
                    {ev.label}
                  </div>
                  <pre className="evidence-content">{ev.content}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="behavior-actions">
        <button
          className="btn btn--sm btn--primary"
          onClick={onVerify}
          disabled={verifying}
        >
          {verifying ? (
            <>
              <span className="spinner" />
              Verifying...
            </>
          ) : (
            'Verify'
          )}
        </button>
        {!editing && (
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}
