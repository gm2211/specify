import { useState } from 'react';
import type { ActionTraceEntry } from '../types';

interface ActionTimelineProps {
  trace: ActionTraceEntry[];
}

const ICONS: Record<ActionTraceEntry['type'], string> = {
  navigation: '→',
  click: '⦿',
  fill: '✎',
  screenshot: '⌾',
  observation: '◎',
  assertion: '✓',
  wait: '◔',
  other: '·',
};

function screenshotSrc(absPath: string): string {
  const basename = absPath.split('/').pop() ?? absPath;
  return `/api/screenshot/${encodeURIComponent(basename)}`;
}

export default function ActionTimeline({ trace }: ActionTimelineProps) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  return (
    <div className="action-timeline">
      <ol className="action-timeline-list">
        {trace.map((step, i) => (
          <li key={i} className={`action-step action-step--${step.type}`}>
            <span className="action-step-marker" aria-hidden="true">
              <span className="action-step-icon">{ICONS[step.type] ?? '·'}</span>
              <span className="action-step-index">{i + 1}</span>
            </span>
            <div className="action-step-body">
              <div className="action-step-head">
                <span className="action-step-type">{step.type}</span>
                <span className="action-step-description">{step.description}</span>
              </div>
              {step.screenshot && (
                <button
                  type="button"
                  className="action-step-shot"
                  onClick={() => setLightbox(step.screenshot!)}
                  aria-label={`View screenshot for step ${i + 1}`}
                >
                  <img
                    src={screenshotSrc(step.screenshot)}
                    alt={`Screenshot at step ${i + 1}`}
                    loading="lazy"
                  />
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      {lightbox && (
        <div
          className="screenshot-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
        >
          <img
            src={screenshotSrc(lightbox)}
            alt="Full-size screenshot"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="screenshot-lightbox-close"
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
