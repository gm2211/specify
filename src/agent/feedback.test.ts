import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ingestFeedback, type FeedbackContext } from './feedback.js';
import { loadObservations, defaultObservationsPath } from './memory-layers.js';
import { eventBus } from './event-bus.js';

function tmpSpec(): { specPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-fb-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { specPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('ingestFeedback: writes an observation for note kind', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const ctx: FeedbackContext = { specPath };
    const r = await ingestFeedback({ kind: 'note', text: 'Header is too dense on mobile.' }, ctx);
    assert.equal(r.ok, true);
    const obs = loadObservations(defaultObservationsPath(specPath));
    assert.equal(obs.length, 1);
    assert.equal(obs[0].source, 'user_feedback');
    assert.match(obs[0].description, /too dense/);
  } finally {
    cleanup();
  }
});

test('ingestFeedback: file_bug spawns bd create and captures the issue id', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const calls: string[][] = [];
    const ctx: FeedbackContext = {
      specPath,
      spawnBd: async (args) => {
        calls.push(args);
        return { ok: true, id: 'SP-fake1' };
      },
    };
    const r = await ingestFeedback({
      kind: 'file_bug',
      text: 'Login button does nothing on click.',
      sessionId: 'ses_xyz',
      areaId: 'auth',
      behaviorId: 'login',
      eventId: 'evt_42',
    }, ctx);
    assert.equal(r.bdIssueId, 'SP-fake1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'create');
    const idx = (flag: string): number => calls[0].indexOf(flag);
    assert.match(calls[0][idx('--title') + 1], /Login button/);
    assert.equal(calls[0][idx('--type') + 1], 'bug');
  } finally {
    cleanup();
  }
});

test('ingestFeedback: important_pattern emits propagation signal', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const seen: string[] = [];
    const detach = eventBus.onAny((e) => seen.push(e.type));
    try {
      await ingestFeedback({
        kind: 'important_pattern',
        text: 'Check empty state on every search bar.',
        sessionId: 'ses_xyz',
      }, { specPath });
    } finally {
      detach();
    }
    assert.ok(seen.includes('feedback:ingested'));
    assert.ok(seen.includes('feedback:propagate_pattern'));
  } finally {
    cleanup();
  }
});

test('ingestFeedback: confidence varies by kind', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const ctx: FeedbackContext = { specPath };
    await ingestFeedback({ kind: 'missed_check', text: 'a' }, ctx);
    await ingestFeedback({ kind: 'false_positive', text: 'b' }, ctx);
    const obs = loadObservations(defaultObservationsPath(specPath));
    const missed = obs.find((o) => o.description === 'a')!;
    const fp = obs.find((o) => o.description === 'b')!;
    assert.ok((missed.confidence ?? 0) > (fp.confidence ?? 0));
  } finally {
    cleanup();
  }
});

test('ingestFeedback: rejects empty text', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    await assert.rejects(() => ingestFeedback({ kind: 'note', text: '   ' }, { specPath }));
  } finally {
    cleanup();
  }
});
