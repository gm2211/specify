import { useState, useEffect, useCallback } from 'react';
import type { Spec } from '../types';
import { fetchSpec } from '../api';

export function useSpec() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSpec()
      .then(setSpec)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { spec, loading, error, refresh };
}
