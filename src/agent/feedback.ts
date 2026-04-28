/**
 * src/agent/feedback.ts — Cooperative QA feedback ingest.
 *
 * The webapp lets the user inline-flag timeline events while watching a verify
 * run. Each flag is an `ingestFeedback({ kind, text, ... })` call. The kind
 * dictates downstream behaviour:
 *
 *   note               — record only, no other action.
 *   important_pattern  — record + signal sibling-check propagation. The
 *                        signalling is just a published event right now;
 *                        consumers wire propagation in their own modules.
 *   missed_check       — record observation tagged "missed". The agent will
 *                        treat these as additional soft checks next session.
 *   false_positive     — record observation tagged "ignore". The agent
 *                        de-prioritises these checks next session.
 *   ignore_pattern     — record observation marking a pattern to skip.
 *   file_bug           — record observation + spawn `bd create` (best-effort,
 *                        silently no-ops if bd isn't on PATH or fails).
 *
 * All observations land in `specify.observations.yaml` (per-spec layer) with
 * provenance set to `user_feedback` and the originating session_id.
 *
 * The function publishes a `feedback:ingested` event after successful write
 * so other modules (sibling-check propagator, confidence model) can react.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { eventBus } from './event-bus.js';
import {
  appendObservation,
  defaultObservationsPath,
  type Observation,
} from './memory-layers.js';

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

export interface FeedbackContext {
  /** Path to the active spec; observations land in its sibling .observations.yaml. */
  specPath: string;
  /** Optional override for the observations file location (mostly tests). */
  observationsPath?: string;
  /** Hook used in tests to stub bd-CLI behaviour. */
  spawnBd?: (args: string[]) => Promise<{ id?: string; ok: boolean; stderr?: string }>;
}

export async function ingestFeedback(input: FeedbackInput, ctx: FeedbackContext): Promise<FeedbackResult> {
  if (!input.kind) throw new Error('feedback: missing kind');
  if (!input.text || !input.text.trim()) throw new Error('feedback: missing text');

  const observationId = `obs_${randomUUID().slice(0, 8)}`;
  const observation: Observation = {
    id: observationId,
    description: input.text.trim(),
    area_id: input.areaId,
    behavior_id: input.behaviorId,
    source: feedbackSource(input.kind),
    session_id: input.sessionId,
    created_at: new Date().toISOString(),
    confidence: defaultConfidenceForKind(input.kind),
  };
  const observationsPath = ctx.observationsPath ?? defaultObservationsPath(ctx.specPath);
  appendObservation(observationsPath, observation);

  let bdIssueId: string | undefined;
  if (input.kind === 'file_bug') {
    const title = truncate(`User feedback: ${input.text}`, 120);
    const description = [
      input.text,
      '',
      input.sessionId ? `Session: ${input.sessionId}` : '',
      input.areaId || input.behaviorId ? `Scope: ${input.areaId ?? '?'}/${input.behaviorId ?? '?'}` : '',
      input.eventId ? `Event: ${input.eventId}` : '',
      `Filed via cooperative-QA feedback (observation ${observationId}).`,
    ].filter(Boolean).join('\n');

    const spawner = ctx.spawnBd ?? defaultSpawnBd;
    const result = await spawner([
      'create',
      '--title', title,
      '--description', description,
      '--type', 'bug',
      '--priority', '2',
    ]);
    if (result.ok && result.id) bdIssueId = result.id;
  }

  eventBus.send('feedback:ingested', {
    kind: input.kind,
    observationId,
    bdIssueId: bdIssueId ?? null,
    sessionId: input.sessionId ?? null,
    areaId: input.areaId ?? null,
    behaviorId: input.behaviorId ?? null,
    text: input.text,
  }, input.sessionId);

  if (input.kind === 'important_pattern') {
    // Signal for in-session sibling-check propagation. Consumers (e.g. the
    // active agent loop) decide what to do; this module just emits.
    eventBus.send('feedback:propagate_pattern', {
      observationId,
      areaId: input.areaId ?? null,
      behaviorId: input.behaviorId ?? null,
      text: input.text,
    }, input.sessionId);
  }

  return { ok: true, observationId, bdIssueId, observationsPath };
}

function feedbackSource(kind: FeedbackKind): Observation['source'] {
  return 'user_feedback';
}

function defaultConfidenceForKind(kind: FeedbackKind): number {
  switch (kind) {
    case 'important_pattern':
    case 'missed_check':
      return 0.8;
    case 'note':
      return 0.6;
    case 'file_bug':
      return 0.9;
    case 'false_positive':
    case 'ignore_pattern':
      return 0.4;
    default:
      return 0.5;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function defaultSpawnBd(args: string[]): Promise<{ id?: string; ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn('bd', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, stderr: 'bd not on PATH' });
      return;
    }
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve({ ok: false, stderr: 'bd spawn error' }));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, stderr });
        return;
      }
      // bd prints something like: "✓ Created issue: SP-abc — Title"
      const m = stdout.match(/Created issue:\s*([A-Za-z0-9_-]+)/);
      resolve({ ok: true, id: m?.[1] });
    });
  });
}
