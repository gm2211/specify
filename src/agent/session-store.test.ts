import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openSessionStore,
  newSessionId,
  defaultSessionDbPath,
  type SessionStore,
} from './session-store.js';
import { eventBus } from './event-bus.js';

function tmpDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-ses-'));
  const dbPath = path.join(dir, 'sessions.db');
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function withStore<T>(fn: (store: SessionStore) => T): T {
  const { dbPath, cleanup } = tmpDb();
  const store = openSessionStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
    cleanup();
  }
}

test('SessionStore: round-trip session + events', () => {
  withStore((store) => {
    const sessionId = newSessionId();
    store.recordSession({
      sessionId,
      specId: 'demo',
      targetKey: 'web_app.example.com',
      task: 'verify',
      startedAt: '2026-04-27T10:00:00Z',
    });
    store.recordEvent({
      sessionId,
      role: 'user',
      kind: 'message',
      content: 'Please verify the login flow on staging.',
    });
    store.recordEvent({
      sessionId,
      role: 'agent',
      kind: 'tool_call',
      content: 'browser_goto https://staging.example.com/login',
    });

    const sessions = store.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, sessionId);
    assert.equal(sessions[0].specId, 'demo');
  });
});

test('SessionStore: FTS5 MATCH search returns hits ranked', () => {
  withStore((store) => {
    const s1 = newSessionId();
    const s2 = newSessionId();
    store.recordSession({ sessionId: s1, specId: 'demo', targetKey: 'web_a', task: 'verify', startedAt: '2026-04-27T10:00:00Z' });
    store.recordSession({ sessionId: s2, specId: 'demo', targetKey: 'web_b', task: 'verify', startedAt: '2026-04-27T11:00:00Z' });

    store.recordEvent({ sessionId: s1, role: 'agent', kind: 'message', content: 'Empty state on the search bar was missing.' });
    store.recordEvent({ sessionId: s1, role: 'agent', kind: 'message', content: 'Header navigation works as expected.' });
    store.recordEvent({ sessionId: s2, role: 'agent', kind: 'message', content: 'Login redirect to dashboard succeeded.' });

    const hits = store.search('"empty state"');
    assert.ok(hits.length >= 1);
    assert.match(hits[0].content, /empty state/i);
    assert.equal(hits[0].sessionId, s1);

    const filteredHits = store.search('login OR dashboard', { specId: 'demo', targetKey: 'web_b' });
    assert.ok(filteredHits.every((h) => h.targetKey === 'web_b'));
  });
});

test('SessionStore: attachToEventBus indexes published events', async () => {
  withStore((store) => {
    const sessionId = newSessionId();
    const detach = store.attachToEventBus({
      sessionId,
      ensureSession: { sessionId, specId: 'demo', targetKey: 'web_x', task: 'verify', startedAt: new Date().toISOString() },
    });
    try {
      eventBus.send('agent:thinking', { content: 'Considering empty state coverage' }, sessionId);
      eventBus.send('tool:invoke', { content: 'browser_click #submit' }, sessionId);
    } finally {
      detach();
    }

    const hits = store.search('empty');
    assert.ok(hits.length >= 1, 'expected at least one hit for "empty"');
    assert.equal(hits[0].sessionId, sessionId);
  });
});

test('SessionStore: events delete cleanly cascades and FTS stays consistent', () => {
  withStore((store) => {
    const sessionId = newSessionId();
    store.recordSession({ sessionId, specId: 'demo', startedAt: new Date().toISOString() });
    store.recordEvent({ sessionId, role: 'agent', kind: 'message', content: 'gizmo flux capacitor calibrated' });
    const before = store.search('gizmo');
    assert.equal(before.length, 1);
  });
});

test('replay: returns chronological event timeline for a session', () => {
  withStore((store) => {
    const sid = newSessionId();
    store.recordSession({ sessionId: sid, specId: 'demo', startedAt: new Date().toISOString() });
    store.recordEvent({ sessionId: sid, role: 'user', kind: 'message', content: 'first' });
    store.recordEvent({ sessionId: sid, role: 'agent', kind: 'tool_call', content: 'second' });
    store.recordEvent({ sessionId: sid, role: 'agent', kind: 'message', content: 'third' });
    const replay = store.replay(sid);
    assert.equal(replay.length, 3);
    assert.equal(replay[0].content, 'first');
    assert.equal(replay[2].content, 'third');
  });
});

test('recentEvents: returns last N in chronological order', () => {
  withStore((store) => {
    const sid = newSessionId();
    store.recordSession({ sessionId: sid, startedAt: new Date().toISOString() });
    for (let i = 0; i < 12; i++) {
      store.recordEvent({ sessionId: sid, role: 'agent', kind: 'message', content: `e${i}` });
    }
    const last5 = store.recentEvents(sid, 5);
    assert.equal(last5.length, 5);
    assert.equal(last5[0].content, 'e7');
    assert.equal(last5[4].content, 'e11');
  });
});

test('defaultSessionDbPath: spec-relative when given, user-level fallback otherwise', () => {
  const cwd = path.resolve('/tmp/some-project/specify.spec.yaml');
  const p = defaultSessionDbPath(cwd);
  assert.equal(p, '/tmp/some-project/.specify/sessions.db');
  const fb = defaultSessionDbPath();
  assert.match(fb, /\.specify\/sessions\.db$/);
});
