import type { Spec, VerifyResults } from './types';

const BASE = '';

export async function fetchSpec(): Promise<Spec> {
  const res = await fetch(`${BASE}/api/spec`);
  if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status}`);
  return res.json();
}

export async function fetchResults(): Promise<VerifyResults | null> {
  const res = await fetch(`${BASE}/api/results`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch results: ${res.status}`);
  return res.json();
}

export async function fetchNarrative(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/narrative`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch narrative: ${res.status}`);
  return res.text();
}

export async function saveSpec(yaml: string): Promise<void> {
  const res = await fetch(`${BASE}/api/spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/yaml' },
    body: yaml,
  });
  if (!res.ok) throw new Error(`Failed to save spec: ${res.status}`);
}

export async function triggerVerify(areaId?: string, behaviorId?: string): Promise<void> {
  const url = areaId && behaviorId
    ? `${BASE}/api/verify/${encodeURIComponent(areaId)}/${encodeURIComponent(behaviorId)}`
    : `${BASE}/api/verify`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to trigger verify: ${res.status}`);
}

export function createWebSocket(): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  return ws;
}
