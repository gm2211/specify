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
  const body = await res.json();
  return typeof body?.content === 'string' && body.content.length > 0 ? body.content : null;
}

export async function saveSpec(yaml: string): Promise<void> {
  const res = await fetch(`${BASE}/api/spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/yaml' },
    body: yaml,
  });
  if (!res.ok) throw new Error(`Failed to save spec: ${res.status}`);
}

export async function triggerVerify(areaId?: string, behaviorId?: string): Promise<{ started: boolean; busy?: boolean }> {
  const url = areaId && behaviorId
    ? `${BASE}/api/verify/${encodeURIComponent(areaId)}/${encodeURIComponent(behaviorId)}`
    : `${BASE}/api/verify`;
  const res = await fetch(url, { method: 'POST' });
  if (res.status === 409) return { started: false, busy: true };
  if (!res.ok) throw new Error(`Failed to trigger verify: ${res.status}`);
  return { started: true };
}

export async function fetchVerifyStatus(): Promise<{ inFlight: boolean }> {
  const res = await fetch(`${BASE}/api/verify/status`);
  if (!res.ok) return { inFlight: false };
  return res.json();
}

export function createWebSocket(): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  return ws;
}

export type FeedbackKind =
  | 'note'
  | 'important_pattern'
  | 'missed_check'
  | 'false_positive'
  | 'ignore_pattern'
  | 'file_bug';

export interface FeedbackInput {
  kind: FeedbackKind;
  text: string;
  sessionId?: string;
  areaId?: string;
  behaviorId?: string;
  eventId?: string;
}

export interface FeedbackResult {
  ok: true;
  observationId: string;
  bdIssueId?: string;
  observationsPath: string;
}

export async function postFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const res = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`Feedback failed: ${body?.message ?? res.status}`);
  }
  return res.json();
}
