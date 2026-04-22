import { useState, useCallback, useEffect, useRef } from 'react';
import { triggerVerify, fetchVerifyStatus } from '../api';

const ALL_KEY = '__all__';

/**
 * Track which behavior (or the whole spec) is actively being verified.
 * A verify run starts on click and stays "in flight" until the server
 * emits `verify:completed` or `verify:failed` over the shared WebSocket.
 */
export function useVerify() {
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [lastError, setLastError] = useState<string | null>(null);

  // Recover state after page refresh.
  useEffect(() => {
    fetchVerifyStatus()
      .then(({ inFlight }) => {
        if (inFlight) {
          setVerifying((prev) => new Set(prev).add(ALL_KEY));
        }
      })
      .catch(() => {});
  }, []);

  // Shared WebSocket — we reuse the single connection App.tsx opens by
  // listening on window messages. Cleaner than opening a second WS.
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      let msg: { type?: string; event?: { type?: string; data?: { scope?: { areaId: string; behaviorId: string } | null; error?: string } } };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== 'agent:event' || !msg.event) return;
      const evt = msg.event;
      if (evt.type === 'verify:started') {
        const scope = evt.data?.scope;
        const key = scope ? `${scope.areaId}/${scope.behaviorId}` : ALL_KEY;
        setVerifying((prev) => new Set(prev).add(key));
        setLastError(null);
      } else if (evt.type === 'verify:completed' || evt.type === 'verify:failed') {
        const scope = evt.data?.scope;
        const key = scope ? `${scope.areaId}/${scope.behaviorId}` : ALL_KEY;
        setVerifying((prev) => {
          const next = new Set(prev);
          next.delete(key);
          next.delete(ALL_KEY);
          return next;
        });
        if (evt.type === 'verify:failed' && evt.data?.error) {
          // Strip ANSI escapes + bare control chars (Playwright errors include them)
          // so the red banner renders cleanly.
          const cleaned = evt.data.error
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
          setLastError(cleaned);
        }
      }
    };
    return () => ws.close();
  }, []);

  const verifyBehavior = useCallback(async (areaId: string, behaviorId: string) => {
    const key = `${areaId}/${behaviorId}`;
    setVerifying((prev) => new Set(prev).add(key));
    setLastError(null);
    try {
      const res = await triggerVerify(areaId, behaviorId);
      if (res.busy) {
        setLastError('A verify run is already in progress.');
        // Keep the key in verifying: the server is busy with something,
        // user should wait for verify:completed rather than re-click.
      }
    } catch (err) {
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const verifyAll = useCallback(async () => {
    setVerifying((prev) => new Set(prev).add(ALL_KEY));
    setLastError(null);
    try {
      const res = await triggerVerify();
      if (res.busy) setLastError('A verify run is already in progress.');
    } catch (err) {
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete(ALL_KEY);
        return next;
      });
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { verifying, verifyBehavior, verifyAll, lastError };
}
