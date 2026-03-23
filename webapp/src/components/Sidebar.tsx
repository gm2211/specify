import type { Area, VerifyResults } from '../types';

interface SidebarProps {
  areas: Area[];
  results: VerifyResults | null;
  selectedArea: string | null;
  onSelectArea: (id: string) => void;
}

function getAreaStatus(area: Area, results: VerifyResults | null): 'passed' | 'failed' | 'untested' {
  if (!results) return 'untested';
  const behaviorIds = new Set(area.behaviors.map((b) => b.id));
  const areaResults = results.results.filter((r) => behaviorIds.has(r.id));
  if (areaResults.length === 0) return 'untested';
  if (areaResults.some((r) => r.status === 'failed')) return 'failed';
  if (areaResults.every((r) => r.status === 'passed')) return 'passed';
  return 'untested';
}

export default function Sidebar({ areas, results, selectedArea, onSelectArea }: SidebarProps) {
  return (
    <nav className="sidebar">
      <div className="sidebar-title">Areas</div>
      <ul className="sidebar-list">
        {areas.map((area) => {
          const status = getAreaStatus(area, results);
          return (
            <li key={area.id}>
              <button
                className={`sidebar-item ${selectedArea === area.id ? 'sidebar-item--selected' : ''}`}
                onClick={() => onSelectArea(area.id)}
              >
                <span className={`status-dot status-dot--${status}`} />
                <span className="sidebar-item-name">{area.name}</span>
                <span className="sidebar-item-count">{area.behaviors.length}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
