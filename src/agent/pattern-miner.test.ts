import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openSessionStore, newSessionId, type SessionStore } from './session-store.js';
import { minePatterns } from './pattern-miner.js';

function withStore<T>(fn: (store: SessionStore) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-mine-'));
  const dbPath = path.join(dir, 'sessions.db');
  const store = openSessionStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeSession(store: SessionStore, sequence: Array<[string, string, string]>): string {
  const sid = newSessionId();
  store.recordSession({ sessionId: sid, startedAt: new Date().toISOString() });
  for (const [role, kind, content] of sequence) {
    store.recordEvent({ sessionId: sid, role, kind, content });
  }
  return sid;
}

test('minePatterns: returns recurring n-grams above thresholds', () => {
  withStore((store) => {
    // Three sessions where the user clicks then types then clicks (the
    // pattern we expect to surface).
    for (let i = 0; i < 3; i++) {
      fakeSession(store, [
        ['user', 'browser:click', 'click signup'],
        ['user', 'browser:input', 'type email'],
        ['user', 'browser:click', 'click submit'],
      ]);
    }
    // Plus one one-off session that should NOT surface.
    fakeSession(store, [
      ['user', 'browser:nav', 'go home'],
      ['user', 'browser:click', 'click logo'],
    ]);

    const patterns = minePatterns(store, { minLen: 2, maxLen: 3, minOccurrences: 2, minSessions: 2 });
    assert.ok(patterns.length > 0);
    const first = patterns[0];
    assert.match(first.signature, /click.*input/);
    assert.equal(first.sessionCount, 3);
    assert.ok(first.examples.length <= 3);
  });
});

test('minePatterns: drops below-threshold candidates', () => {
  withStore((store) => {
    fakeSession(store, [
      ['user', 'browser:click', 'a'],
      ['user', 'browser:input', 'b'],
    ]);
    const patterns = minePatterns(store, { minOccurrences: 5, minSessions: 5 });
    assert.equal(patterns.length, 0);
  });
});

test('minePatterns: role filter restricts mining', () => {
  withStore((store) => {
    for (let i = 0; i < 3; i++) {
      fakeSession(store, [
        ['user', 'browser:click', 'a'],
        ['agent', 'tool_call', 'b'],
        ['user', 'browser:input', 'c'],
      ]);
    }
    const userOnly = minePatterns(store, { roles: ['user'], minOccurrences: 2, minSessions: 2 });
    for (const p of userOnly) {
      for (const t of p.tokens) {
        assert.equal(t.role, 'user', `expected only user-role tokens, got ${t.role}`);
      }
    }
  });
});

test('minePatterns: excludes by kind substring', () => {
  withStore((store) => {
    for (let i = 0; i < 3; i++) {
      fakeSession(store, [
        ['agent', 'heartbeat', 'tick'],
        ['agent', 'tool_call', 'real'],
        ['agent', 'heartbeat', 'tick'],
      ]);
    }
    const patterns = minePatterns(store, { minOccurrences: 2, minSessions: 2 });
    for (const p of patterns) {
      assert.doesNotMatch(p.signature, /heartbeat/);
    }
  });
});

test('minePatterns: scoring prefers sessionCount over raw count', () => {
  withStore((store) => {
    // Pattern A appears 3 times in 3 different sessions.
    for (let i = 0; i < 3; i++) {
      fakeSession(store, [['user', 'a:1', '_'], ['user', 'a:2', '_']]);
    }
    // Pattern B appears 5 times in a single session.
    const sid = newSessionId();
    store.recordSession({ sessionId: sid, startedAt: new Date().toISOString() });
    for (let i = 0; i < 5; i++) {
      store.recordEvent({ sessionId: sid, role: 'user', kind: 'b:1', content: '_' });
      store.recordEvent({ sessionId: sid, role: 'user', kind: 'b:2', content: '_' });
    }
    const patterns = minePatterns(store, { minOccurrences: 2, minSessions: 1 });
    const a = patterns.find((p) => p.signature.includes('a:1'));
    const b = patterns.find((p) => p.signature.includes('b:1'));
    assert.ok(a && b);
    // sessionCount=3 weighted ⇒ a (score 3*3+3=12) > b (score 1*3+5=8)
    const aIdx = patterns.indexOf(a!);
    const bIdx = patterns.indexOf(b!);
    assert.ok(aIdx < bIdx, 'cross-session pattern should outrank single-session loop');
  });
});
