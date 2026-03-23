import { useState, useCallback } from 'react';
import { triggerVerify } from '../api';

export function useVerify() {
  const [verifying, setVerifying] = useState<Set<string>>(new Set());

  const verifyBehavior = useCallback(async (areaId: string, behaviorId: string) => {
    const key = `${areaId}/${behaviorId}`;
    setVerifying((prev) => new Set(prev).add(key));
    try {
      await triggerVerify(areaId, behaviorId);
    } finally {
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const verifyAll = useCallback(async () => {
    setVerifying((prev) => new Set(prev).add('__all__'));
    try {
      await triggerVerify();
    } finally {
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete('__all__');
        return next;
      });
    }
  }, []);

  return { verifying, verifyBehavior, verifyAll };
}
