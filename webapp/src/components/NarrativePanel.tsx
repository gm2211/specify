import { useState, useEffect } from 'react';
import { marked } from 'marked';

interface NarrativePanelProps {
  description?: string;
  narrative: string | null;
}

marked.setOptions({ gfm: true, breaks: true });

export default function NarrativePanel({ description, narrative }: NarrativePanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [html, setHtml] = useState('');

  useEffect(() => {
    const md = narrative ?? (description ? description : '');
    if (!md) {
      setHtml('');
      return;
    }
    const result = marked.parse(md);
    if (typeof result === 'string') setHtml(result);
    else result.then(setHtml);
  }, [narrative, description]);

  if (!html) return null;

  return (
    <section className="narrative-panel">
      <button
        type="button"
        className="narrative-panel-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <svg
          className={`evidence-chevron ${expanded ? 'evidence-chevron--open' : ''}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="currentColor"
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
        Narrative
      </button>
      {expanded && (
        <div
          className="narrative-panel-body"
          // marked's sanitizer was removed in v5; spec content is authored by
          // the project owner so we trust it. If that assumption changes,
          // swap in DOMPurify here.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </section>
  );
}
