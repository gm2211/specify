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

test('rename: migrates a bare-keyed row to the new bare id, preserving tallies', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.record('login', 'accept');
    store.record('login', 'accept');
    store.record('login', 'override');

    const result = store.rename('auth/login', 'auth/signin');
    assert.equal(result.migrated, true);
    assert.equal(result.from, 'login');
    assert.equal(result.to, 'signin');

    const migrated = store.get('signin');
    assert.equal(migrated.accepts, 2);
    assert.equal(migrated.overrides, 1);
    assert.equal(store.get('login').accepts, 0, 'old key should no longer hold the row');
  } finally {
    cleanup();
  }
});

test('rename: migrates an exact fully-qualified key verbatim', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.record('auth/login', 'accept');

    const result = store.rename('auth/login', 'auth/signin');
    assert.equal(result.migrated, true);
    assert.equal(result.from, 'auth/login');
    assert.equal(result.to, 'auth/signin');
    assert.equal(store.get('auth/signin').accepts, 1);
  } finally {
    cleanup();
  }
});

test('rename: survives a reopened store (persists to disk)', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    new ConfidenceStore(filePath).record('login', 'accept');
    const store = new ConfidenceStore(filePath);
    store.rename('auth/login', 'auth/signin');

    const reopened = new ConfidenceStore(filePath);
    assert.equal(reopened.get('signin').accepts, 1);
    assert.equal(reopened.get('login').accepts, 0);
  } finally {
    cleanup();
  }
});

test('rename: no-op when no row matches the old id', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.record('signup', 'accept');

    const result = store.rename('auth/login', 'auth/signin');
    assert.equal(result.migrated, false);
    assert.equal(store.get('signup').accepts, 1, 'unrelated rows are untouched');
  } finally {
    cleanup();
  }
});

test('recordFromCrossCheck: a single mismatch does not count as an override', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    const row = store.get('checkout/free-shipping');
    assert.equal(row.overrides, 0);
    assert.equal(row.consecutiveMismatches, 1);
  } finally {
    cleanup();
  }
});

test('recordFromCrossCheck: 2 consecutive mismatches count as one override', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    const row = store.get('checkout/free-shipping');
    assert.equal(row.overrides, 1);
    assert.equal(row.consecutiveMismatches, 2);
  } finally {
    cleanup();
  }
});

test('recordFromCrossCheck: 3 consecutive mismatches count as two overrides (once the streak crosses 2 each time)', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    const row = store.get('checkout/free-shipping');
    assert.equal(row.overrides, 2);
  } finally {
    cleanup();
  }
});

test('recordFromCrossCheck: an agreement resets the mismatch streak', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    store.recordFromCrossCheck('checkout/free-shipping', false);
    store.recordFromCrossCheck('checkout/free-shipping', true);
    const row = store.get('checkout/free-shipping');
    assert.equal(row.overrides, 0);
    assert.equal(row.consecutiveMismatches, 0);
  } finally {
    cleanup();
  }
});

test('attachToEventBus: crosscheck:result events feed recordFromCrossCheck', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const store = new ConfidenceStore(filePath);
    const detach = store.attachToEventBus();
    try {
      eventBus.send('crosscheck:result', { id: 'checkout/free-shipping', agentStatus: 'passed', testStatus: 'failed', agreement: false });
      eventBus.send('crosscheck:result', { id: 'checkout/free-shipping', agentStatus: 'passed', testStatus: 'failed', agreement: false });
    } finally {
      detach();
    }
    const row = store.get('checkout/free-shipping');
    assert.equal(row.overrides, 1);
  } finally {
    cleanup();
  }
});

test('defaultConfidencePath resolves inside directory specs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-confidence-dir-'));
  try {
    const specDir = path.join(dir, 'spec');
    fs.mkdirSync(specDir);
    assert.equal(defaultConfidencePath(specDir), path.join(specDir, '.specify', 'confidence.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
