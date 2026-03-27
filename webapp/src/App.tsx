import { useState, useEffect, useMemo, useCallback } from 'react';
import type { StatusFilter } from './types';
import { createWebSocket } from './api';
import { useSpec } from './hooks/useSpec';
import { useResults } from './hooks/useResults';
import { useVerify } from './hooks/useVerify';
import Layout from './components/Layout';
import Sidebar from './components/Sidebar';
import Summary from './components/Summary';
import SearchBar from './components/SearchBar';
import AreaCard from './components/AreaCard';

export default function App() {
  const { spec, loading: specLoading, error: specError, refresh: refreshSpec } = useSpec();
  const { results, refresh: refreshResults } = useResults();
  const { verifying, verifyBehavior, verifyAll } = useVerify();

  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [expandedAreas, setExpandedAreas] = useState<Set<string>>(new Set());

  // WebSocket for live updates
  useEffect(() => {
    const ws = createWebSocket();
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'spec-updated') refreshSpec();
        if (msg.type === 'results-updated' || msg.type === 'verify-complete') refreshResults();
      } catch {
        // ignore non-JSON messages
      }
    };
    ws.onclose = () => {
      // Reconnect after a delay
      setTimeout(() => {
        // Component will re-mount or user will refresh
      }, 3000);
    };
    return () => ws.close();
  }, [refreshSpec, refreshResults]);

  // Expand all areas by default when spec loads
  useEffect(() => {
    if (spec) {
      setExpandedAreas(new Set(spec.areas.map((a) => a.id)));
    }
  }, [spec]);

  // Collect all tags
  const allTags = useMemo(() => {
    if (!spec) return [];
    const tags = new Set<string>();
    spec.areas.forEach((a) =>
      a.behaviors.forEach((b) => b.tags?.forEach((t) => tags.add(t)))
    );
    return Array.from(tags).sort();
  }, [spec]);

  const handleSelectArea = useCallback((id: string) => {
    setSelectedArea(id);
    setExpandedAreas((prev) => new Set(prev).add(id));
    const el = document.getElementById(`area-${id}`);
    if (el) (el as unknown as { scrollIntoView: (opts: ScrollIntoViewOptions) => void }).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleToggleArea = useCallback((id: string) => {
    setExpandedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleVerify = useCallback(
    async (areaId: string, behaviorId: string) => {
      await verifyBehavior(areaId, behaviorId);
      refreshResults();
    },
    [verifyBehavior, refreshResults]
  );

  const handleEdit = useCallback(
    (_areaId: string, _behaviorId: string, _newDescription: string) => {
      // Editing would require a spec update endpoint; placeholder for now
    },
    []
  );

  if (specLoading) {
    return (
      <div className="loading-screen">
        <div className="spinner spinner--lg" />
        <p>Loading specification...</p>
      </div>
    );
  }

  if (specError || !spec) {
    return (
      <div className="error-screen">
        <h2>Failed to load specification</h2>
        <p>{specError ?? 'No spec data returned'}</p>
        <button className="btn btn--primary" onClick={refreshSpec}>
          Retry
        </button>
      </div>
    );
  }

  const header = (
    <div className="header-content">
      <div className="header-left">
        <h1 className="header-title">{spec.name}</h1>
        {spec.description && (
          <span className="header-description">{spec.description}</span>
        )}
      </div>
      <div className="header-right">
        <Summary spec={spec} results={results} />
        <button
          className="btn btn--primary btn--verify-all"
          onClick={verifyAll}
          disabled={verifying.has('__all__')}
        >
          {verifying.has('__all__') ? (
            <>
              <span className="spinner" />
              Verifying...
            </>
          ) : (
            'Verify All'
          )}
        </button>
      </div>
    </div>
  );

  const sidebar = (
    <Sidebar
      areas={spec.areas}
      results={results}
      selectedArea={selectedArea}
      onSelectArea={handleSelectArea}
    />
  );

  return (
    <Layout header={header} sidebar={sidebar}>
      <SearchBar
        searchText={searchText}
        onSearchChange={setSearchText}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        tagFilter={tagFilter}
        onTagChange={setTagFilter}
        allTags={allTags}
      />
      <div className="area-list">
        {spec.areas.map((area) => (
          <AreaCard
            key={area.id}
            area={area}
            results={results}
            expanded={expandedAreas.has(area.id)}
            onToggle={() => handleToggleArea(area.id)}
            searchText={searchText}
            statusFilter={statusFilter}
            tagFilter={tagFilter}
            onVerify={handleVerify}
            verifying={verifying}
            onEdit={handleEdit}
          />
        ))}
      </div>
    </Layout>
  );
}
