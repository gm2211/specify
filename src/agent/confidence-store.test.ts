import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConfidenceStore,
  autonomyDecision,
  confidenceFor,
  defaultConfidencePath,
} from './confidence-store.js';
import { eventBus } from './event-bus.js';

function tmpFile(): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-conf-'));
  const filePath = path.join(dir, 'confidence.json');
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('record + get round-trip', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.record('login', 'accept');
    store.record('login', 'accept');
    store.record('login', 'override');
    const row = store.get('login');
    assert.equal(row.accepts, 2);
    assert.equal(row.overrides, 1);
  } finally {
    cleanup();
  }
});

test('persistence: state survives a fresh store on the same file', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    new ConfidenceStore(filePath).record('signup', 'accept');
    const reopen = new ConfidenceStore(filePath).get('signup');
    assert.equal(reopen.accepts, 1);
  } finally {
    cleanup();
  }
});

test('confidenceFor: returns 0.5 for unknown, monotone in accepts', () => {
  assert.equal(confidenceFor({ behaviorId: 'x', accepts: 0, overrides: 0, lastUpdatedAt: '' }), 0.5);
  const lo = confidenceFor({ behaviorId: 'x', accepts: 1, overrides: 1, lastUpdatedAt: '' });
  const hi = confidenceFor({ behaviorId: 'x', accepts: 9, overrides: 1, lastUpdatedAt: '' });
  assert.ok(hi > lo);
  assert.ok(hi < 1, 'with the +1 prior, confidence cannot reach exactly 1.0');
});

test('autonomyDecision: ask_uncertain asks below 0.7 confidence', () => {
  const lowRow = { behaviorId: 'x', accepts: 1, overrides: 5, lastUpdatedAt: '' };
  const highRow = { behaviorId: 'y', accepts: 15, overrides: 1, lastUpdatedAt: '' };
  assert.equal(autonomyDecision(lowRow, 'ask_uncertain'), 'ask');
  assert.equal(autonomyDecision(highRow, 'ask_uncertain'), 'silent');
  assert.equal(autonomyDecision(highRow, 'ask_everything'), 'ask');
  assert.equal(autonomyDecision(lowRow, 'autonomous'), 'silent');
});

test('attachToEventBus: feedback:ingested updates per-behavior tally', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    const detach = store.attachToEventBus();
    try {
      eventBus.send('feedback:ingested', { behaviorId: 'login', kind: 'missed_check' });
      eventBus.send('feedback:ingested', { behaviorId: 'login', kind: 'file_bug' });
      eventBus.send('feedback:ingested', { behaviorId: 'login', kind: 'note' });
      eventBus.send('feedback:ingested', { behaviorId: 'login', kind: 'important_pattern' });
    } finally {
      detach();
    }
    const row = store.get('login');
    // accept: file_bug + important_pattern = 2
    // override: missed_check = 1
    // note: no change
    assert.equal(row.accepts, 2);
    assert.equal(row.overrides, 1);
  } finally {
    cleanup();
  }
});

test('events without behaviorId are ignored', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    const detach = store.attachToEventBus();
    try {
      eventBus.send('feedback:ingested', { kind: 'missed_check' });
    } finally {
      detach();
    }
    assert.equal(store.getAll().length, 0);
  } finally {
    cleanup();
  }
});

test('defaultConfidencePath resolves next to spec', () => {
  const p = defaultConfidencePath('/tmp/proj/specify.spec.yaml');
  assert.equal(p, '/tmp/proj/.specify/confidence.json');
});
