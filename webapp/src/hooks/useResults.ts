import { useState, useEffect, useCallback } from 'react';
import type { VerifyResults } from '../types';
import { fetchResults } from '../api';

export function useResults() {
  const [results, setResults] = useState<VerifyResults | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchResults()
      .then(setResults)
      .catch(() => setResults(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { results, loading, refresh };
}
