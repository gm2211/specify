import { useEffect, useRef, useState } from 'react';
import FeedbackForm from './FeedbackForm';

interface AgentEvent {
  type: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  ts?: number;
}

interface LogLine {
  id: number;
  kind: 'text' | 'tool' | 'behavior' | 'status' | 'error';
  text: string;
  ts: number;
  sessionId?: string;
  /** Behavior id when the underlying event was a behavior:* event. */
  behaviorId?: string;
}

interface ActivityStreamProps {
  /** Whether any verify run is in flight. */
  active: boolean;
}

function eventToLine(evt: AgentEvent, id: number): LogLine | null {
  const now = evt.ts ?? Date.now();
  const d = evt.data ?? {};
  switch (evt.type) {
    case 'agent:started':
      return { id, kind: 'status', text: `agent started (${d.task ?? 'task'})`, ts: now };
    case 'agent:text': {
      const t = typeof d.text === 'string' ? clean(d.text).trim() : '';
      if (!t) return null;
      return { id, kind: 'text', text: t, ts: now };
    }
    case 'agent:tool_use': {
      const s = typeof d.summary === 'string' ? clean(d.summary) : '';
      if (!s) return null;
      return { id, kind: 'tool', text: s, ts: now };
    }
    case 'agent:retry':
      return { id, kind: 'status', text: `retrying (attempt ${d.attempt}/${d.maxRetries})`, ts: now };
    case 'agent:ask_user':
      return { id, kind: 'status', text: `agent asks: ${d.question}`, ts: now };
    case 'agent:completed':
      return { id, kind: 'status', text: `agent completed — pass: ${d.pass} ($${Number(d.costUsd ?? 0).toFixed(4)})`, ts: now };
    case 'agent:error':
      return { id, kind: 'error', text: `agent error: ${clean(String(d.subtype ?? ''))}`, ts: now };
    case 'agent:failed':
      return { id, kind: 'error', text: `agent failed: ${clean(String(d.error ?? ''))}`, ts: now };
    case 'behavior:passed':
    case 'behavior:failed':
    case 'behavior:skipped': {
      const status = evt.type.split(':')[1];
      return { id, kind: 'behavior', text: `${status}: ${d.id}`, ts: now, sessionId: evt.sessionId, behaviorId: typeof d.id === 'string' ? d.id : undefined };
    }
    case 'verify:started':
      return { id, kind: 'status', text: `verify started${d.scope ? ` (${(d.scope as { areaId: string; behaviorId: string }).areaId}/${(d.scope as { areaId: string; behaviorId: string }).behaviorId})` : ''}`, ts: now };
    case 'verify:completed':
      return { id, kind: 'status', text: 'verify complete', ts: now };
    case 'verify:failed':
      return { id, kind: 'error', text: `verify failed: ${clean(String(d.error ?? ''))}`, ts: now };
    default:
      return null;
  }
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

// Strip ANSI escape sequences and bare C0 control chars (except newline/tab)
// so error messages from Playwright/colors render readably in HTML.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const C0_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
function clean(s: string): string {
  return s.replace(ANSI_RE, '').replace(C0_RE, '');
}

export default function ActivityStream({ active }: ActivityStreamProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [feedbackFor, setFeedbackFor] = useState<number | null>(null);
  const [flashIds, setFlashIds] = useState<Set<number>>(() => new Set());
  const [sessionFeedbackOpen, setSessionFeedbackOpen] = useState(false);
  const nextId = useRef(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const flashSuccess = (id: number): void => {
    setFlashIds((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      setFlashIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 2400);
  };

  const lastSessionId = lines.length > 0 ? lines[lines.length - 1].sessionId : undefined;

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.onmessage = (ev) => {
      let msg: { type?: string; event?: AgentEvent };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== 'agent:event' || !msg.event) return;
      const line = eventToLine(msg.event, nextId.current++);
      if (!line) return;
      // Carry the sessionId from the source event so feedback can attribute
      // properly even when eventToLine didn't set it explicitly.
      if (!line.sessionId && msg.event.sessionId) line.sessionId = msg.event.sessionId;
      setLines((prev) => {
        const next = [...prev, line];
        // Cap at 200 lines so the DOM doesn't grow forever.
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    };
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, expanded]);

  // Hide entirely when nothing has ever happened AND nothing is running.
  if (!active && lines.length === 0) return null;

  return (
    <section className={`activity-stream ${active ? 'activity-stream--active' : ''}`}>
      <button
        type="button"
        className="activity-stream-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className={`activity-stream-pulse ${active ? 'activity-stream-pulse--on' : ''}`} />
        <span className="activity-stream-title">
          {active ? 'Agent running' : 'Last agent run'}
        </span>
        <span className="activity-stream-count">{lines.length} event{lines.length === 1 ? '' : 's'}</span>
        <span className="activity-stream-toggle">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="activity-stream-body" ref={bodyRef}>
          {lines.length === 0 ? (
            <div className="activity-stream-empty">Waiting for agent output…</div>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={`activity-line activity-line--${line.kind} ${flashIds.has(line.id) ? 'activity-line--flagged' : ''}`}>
                <span className="activity-time">{timeLabel(line.ts)}</span>
                <span className="activity-kind">{line.kind}</span>
                <span className="activity-text">{line.text}</span>
                <button
                  type="button"
                  className="activity-flag-btn"
                  title="Add feedback on this event"
                  onClick={() => setFeedbackFor(feedbackFor === line.id ? null : line.id)}
                  aria-pressed={feedbackFor === line.id}
                >
                  ⚑
                </button>
                {feedbackFor === line.id && (
                  <div className="activity-feedback">
                    <FeedbackForm
                      compact
                      sessionId={line.sessionId}
                      behaviorId={line.behaviorId}
                      eventId={`evt_${line.id}`}
                      defaultKind={line.kind === 'error' || line.kind === 'behavior' ? 'file_bug' : 'note'}
                      placeholder="What did you notice about this event?"
                      onDone={() => {
                        flashSuccess(line.id);
                        setFeedbackFor(null);
                      }}
                      onCancel={() => setFeedbackFor(null)}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
      {expanded && lines.length > 0 && (
        <div className="activity-session-feedback">
          {sessionFeedbackOpen ? (
            <FeedbackForm
              sessionId={lastSessionId}
              defaultKind="note"
              placeholder="Session-level feedback (anything that didn't fit a single row)…"
              onDone={() => setSessionFeedbackOpen(false)}
              onCancel={() => setSessionFeedbackOpen(false)}
            />
          ) : (
            <button type="button" className="activity-session-feedback-toggle" onClick={() => setSessionFeedbackOpen(true)}>
              Add session-level feedback
            </button>
          )}
        </div>
      )}
    </section>
  );
}
