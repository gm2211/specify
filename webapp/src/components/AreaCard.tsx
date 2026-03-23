import type { Area, VerifyResults, StatusFilter } from '../types';
import BehaviorCard from './BehaviorCard';

interface AreaCardProps {
  area: Area;
  results: VerifyResults | null;
  expanded: boolean;
  onToggle: () => void;
  searchText: string;
  statusFilter: StatusFilter;
  tagFilter: string[];
  onVerify: (areaId: string, behaviorId: string) => void;
  verifying: Set<string>;
  onEdit: (areaId: string, behaviorId: string, newDescription: string) => void;
}

export default function AreaCard({
  area,
  results,
  expanded,
  onToggle,
  searchText,
  statusFilter,
  tagFilter,
  onVerify,
  verifying,
  onEdit,
}: AreaCardProps) {
  const resultMap = new Map(results?.results.map((r) => [r.id, r]) ?? []);

  const filteredBehaviors = area.behaviors.filter((b) => {
    // Search filter
    if (searchText) {
      const q = searchText.toLowerCase();
      const matchesSearch =
        b.id.toLowerCase().includes(q) ||
        b.description.toLowerCase().includes(q) ||
        (b.details?.toLowerCase().includes(q) ?? false);
      if (!matchesSearch) return false;
    }

    // Status filter
    if (statusFilter !== 'all') {
      const result = resultMap.get(b.id);
      const status = result?.status ?? 'untested';
      if (status !== statusFilter) return false;
    }

    // Tag filter
    if (tagFilter.length > 0) {
      if (!b.tags || !tagFilter.some((t) => b.tags!.includes(t))) return false;
    }

    return true;
  });

  // Area-level stats
  const areaResults = area.behaviors.map((b) => resultMap.get(b.id));
  const passed = areaResults.filter((r) => r?.status === 'passed').length;
  const failed = areaResults.filter((r) => r?.status === 'failed').length;
  const total = area.behaviors.length;

  // Don't render if all behaviors are filtered out
  if (searchText || statusFilter !== 'all' || tagFilter.length > 0) {
    if (filteredBehaviors.length === 0) return null;
  }

  return (
    <div className="area-card" id={`area-${area.id}`}>
      <button className="area-card-header" onClick={onToggle}>
        <svg
          className={`area-chevron ${expanded ? 'area-chevron--open' : ''}`}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="currentColor"
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
        <h2 className="area-card-title">{area.name}</h2>
        <div className="area-card-stats">
          {passed > 0 && <span className="mini-badge mini-badge--passed">{passed}</span>}
          {failed > 0 && <span className="mini-badge mini-badge--failed">{failed}</span>}
          <span className="area-card-count">{total} behaviors</span>
        </div>
      </button>

      {expanded && (
        <div className="area-card-body">
          {area.prose && <p className="area-prose">{area.prose}</p>}
          <div className="behavior-list">
            {filteredBehaviors.map((behavior) => (
              <BehaviorCard
                key={behavior.id}
                areaId={area.id}
                behavior={behavior}
                result={resultMap.get(behavior.id)}
                onVerify={() => onVerify(area.id, behavior.id)}
                verifying={verifying.has(`${area.id}/${behavior.id}`)}
                onEdit={(desc) => onEdit(area.id, behavior.id, desc)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
