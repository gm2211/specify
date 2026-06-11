import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveMessage, loadMessages, pruneMessages, stateDir } from './inbox-state.js';
import type { InboxMessage } from './inbox.js';

function makeMsg(id: string, status: InboxMessage['status'] = 'completed', createdAt?: string): InboxMessage {
  return {
    id,
    createdAt: createdAt ?? new Date().toISOString(),
    status,
    request: { task: 'freeform', prompt: 'hello' },
  };
}

function useTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-state-'));
  process.env.SPECIFY_INBOX_STATE_DIR = dir;
  return dir;
}

function cleanTmpDir(dir: string): void {
  delete process.env.SPECIFY_INBOX_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
}

test('inbox-state: saveMessage then loadMessages round-trips a message', () => {
  const dir = useTmpDir();
  try {
    const msg = makeMsg('msg_aabbccdd', 'completed');
    msg.error = undefined;
    msg.result = { result: 'ok', costUsd: 0.05 };

    saveMessage(msg);

    assert.ok(fs.existsSync(path.join(dir, 'msg_aabbccdd.json')));
    // No .tmp leftover
    assert.ok(!fs.existsSync(path.join(dir, 'msg_aabbccdd.json.tmp')));

    const loaded = loadMessages();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, msg.id);
    assert.equal(loaded[0].status, 'completed');
    assert.equal(loaded[0].result?.costUsd, 0.05);
    assert.equal(loaded[0].request.task, 'freeform');
  } finally {
    cleanTmpDir(dir);
  }
});

test('inbox-state: loadMessages returns [] when dir is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-inbox-state-missing-'));
  // Point to a subdir that doesn't exist
  process.env.SPECIFY_INBOX_STATE_DIR = path.join(dir, 'nonexistent');
  try {
    const loaded = loadMessages();
    assert.deepEqual(loaded, []);
  } finally {
    delete process.env.SPECIFY_INBOX_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox-state: corrupt file is skipped, valid files are returned', () => {
  const dir = useTmpDir();
  try {
    const good = makeMsg('msg_good0001', 'running');
    saveMessage(good);

    // Write a corrupt JSON file
    fs.writeFileSync(path.join(dir, 'msg_corrupt01.json'), '{ invalid json !!!', 'utf-8');

    const loaded = loadMessages();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'msg_good0001');
  } finally {
    cleanTmpDir(dir);
  }
});

test('inbox-state: pruneMessages caps the number of records to max', () => {
  const dir = useTmpDir();
  try {
    const base = Date.now();
    for (let i = 0; i < 10; i++) {
      const msg = makeMsg(`msg_${String(i).padStart(8, '0')}`, 'completed',
        new Date(base + i * 1000).toISOString());
      saveMessage(msg);
    }

    assert.equal(loadMessages().length, 10);

    pruneMessages(5);

    const remaining = loadMessages();
    assert.equal(remaining.length, 5);

    // The 5 newest should survive (indices 5–9)
    const ids = remaining.map((m) => m.id).sort();
    for (let i = 5; i < 10; i++) {
      assert.ok(ids.includes(`msg_${String(i).padStart(8, '0')}`), `expected msg_${i} to survive`);
    }
  } finally {
    cleanTmpDir(dir);
  }
});

test('inbox-state: stateDir respects SPECIFY_INBOX_STATE_DIR env var', () => {
  const dir = useTmpDir();
  try {
    assert.equal(stateDir(), dir);
  } finally {
    cleanTmpDir(dir);
  }
});

test('inbox-state: saveMessage is idempotent — overwriting same id works', () => {
  const dir = useTmpDir();
  try {
    const msg = makeMsg('msg_idem0001', 'running');
    saveMessage(msg);

    msg.status = 'completed';
    msg.result = { result: 'ok', costUsd: 0.1 };
    saveMessage(msg);

    const loaded = loadMessages();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].status, 'completed');
    assert.equal(loaded[0].result?.costUsd, 0.1);
  } finally {
    cleanTmpDir(dir);
  }
});
