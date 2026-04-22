import { useState, useEffect, useCallback } from 'react';
import type { VerifyResults } from '../types';
import { fetchResults } from '../api';

export function useResults() {
  const [results, setResults] = useState<VerifyResults | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchResults()
      .then((r) => {
        // Server returns {} when no verify-result.json exists yet. Normalize
        // to null so consumers can assume a result has shape {summary, results}.
        if (!r || !(r as VerifyResults).summary || !(r as VerifyResults).results) {
          setResults(null);
        } else {
          setResults(r);
        }
      })
      .catch(() => setResults(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { results, loading, refresh };
}
