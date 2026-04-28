import { useState } from 'react';
import { postFeedback, type FeedbackInput, type FeedbackKind } from '../api';

const KINDS: { value: FeedbackKind; label: string; hint: string }[] = [
  { value: 'note', label: 'Note', hint: 'observation worth keeping; no action' },
  { value: 'important_pattern', label: 'Important pattern', hint: 'check this everywhere; agent will propagate to siblings' },
  { value: 'missed_check', label: 'Missed check', hint: 'agent should have checked this' },
  { value: 'false_positive', label: 'False positive', hint: 'agent flagged something that is not a problem' },
  { value: 'ignore_pattern', label: 'Ignore pattern', hint: 'skip this kind of finding next time' },
  { value: 'file_bug', label: 'File bug', hint: 'creates a beads issue and records the observation' },
];

export interface FeedbackFormProps {
  /** Bound context for the feedback (event/behavior/session) */
  sessionId?: string;
  areaId?: string;
  behaviorId?: string;
  eventId?: string;
  /** Compact rendering for inline-on-row use; full layout otherwise */
  compact?: boolean;
  defaultKind?: FeedbackKind;
  placeholder?: string;
  onDone?: (result: { observationId: string; bdIssueId?: string; kind: FeedbackKind }) => void;
  onCancel?: () => void;
}

export default function FeedbackForm(props: FeedbackFormProps) {
  const [kind, setKind] = useState<FeedbackKind>(props.defaultKind ?? 'note');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Feedback text required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: FeedbackInput = {
        kind,
        text,
        sessionId: props.sessionId,
        areaId: props.areaId,
        behaviorId: props.behaviorId,
        eventId: props.eventId,
      };
      const r = await postFeedback(input);
      setText('');
      props.onDone?.({ observationId: r.observationId, bdIssueId: r.bdIssueId, kind });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`feedback-form ${props.compact ? 'feedback-form--compact' : ''}`} onSubmit={submit}>
      <div className="feedback-form-row">
        <select
          className="feedback-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as FeedbackKind)}
          disabled={busy}
          title={KINDS.find((k) => k.value === kind)?.hint}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value} title={k.hint}>{k.label}</option>
          ))}
        </select>
        <textarea
          className="feedback-text"
          rows={props.compact ? 1 : 3}
          placeholder={props.placeholder ?? 'What did you notice?'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="feedback-form-actions">
        <button type="submit" className="feedback-submit" disabled={busy || !text.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        {props.onCancel && (
          <button type="button" className="feedback-cancel" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {error && <div className="feedback-error">{error}</div>}
    </form>
  );
}
