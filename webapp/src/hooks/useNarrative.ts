import { useEffect, useState, useCallback } from 'react';
import { fetchNarrative } from '../api';

export function useNarrative() {
  const [narrative, setNarrative] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchNarrative()
      .then(setNarrative)
      .catch(() => setNarrative(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { narrative, refresh };
}
