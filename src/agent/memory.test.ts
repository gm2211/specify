import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyDeltas,
  loadMemory,
  memoryPath,
  renderMemoryPrompt,
  saveMemory,
  targetKey,
} from './memory.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'specify-mem-'));
}

test('targetKey derives stable keys from URLs and CLI binaries', () => {
  assert.equal(targetKey({ type: 'web', url: 'https://staging.example.com/path' }), 'web_staging.example.com');
  assert.equal(targetKey({ type: 'web', url: 'http://localhost:3000' }), 'web_localhost_3000');
  assert.equal(targetKey({ type: 'cli', binary: './specify' }), 'cli_specify');
  assert.equal(targetKey({ type: 'web' }), 'unknown');
});

test('memoryPath is scoped per spec_id and target_key', () => {
  const p = memoryPath('/tmp/app/spec.yaml', 'My App', { type: 'web', url: 'https://x.test' });
  assert.ok(p.includes('.specify/memory'));
  assert.ok(p.includes('My_App'));
  assert.ok(p.endsWith('web_x.test.json'));
});

test('loadMemory on missing file returns empty store', () => {
  const dir = tmp();
  const p = path.join(dir, 'mem.json');
  const file = loadMemory(p);
  assert.equal(file.version, 1);
  assert.deepEqual(file.rows, []);
});

test('applyDeltas inserts new rows and dedupes similar content', () => {
  const dir = tmp();
  const p = path.join(dir, 'mem.json');
  let file = loadMemory(p);

  file = applyDeltas(file, 'run_1', [
    { type: 'playbook', area_id: 'auth', content: 'Fill #email then #password, click [type=submit].' },
    { type: 'quirk', area_id: 'dashboard', content: 'Stats widget races: wait 2s after nav.', severity: 'minor', suggested_fix: 'Await XHR completion explicitly.' },
  ]);
  assert.equal(file.rows.length, 2);

  // Re-applying similar content updates instead of duplicating
  file = applyDeltas(file, 'run_2', [
    { type: 'playbook', area_id: 'auth', content: 'Fill #email then #password, click the submit button.' },
  ]);
  assert.equal(file.rows.length, 2);
  const auth = file.rows.find((r) => r.area_id === 'auth')!;
  assert.equal(auth.last_confirmed_run_id, 'run_2');

  // Contradictions demote via counter
  file = applyDeltas(file, 'run_3', [
    { type: 'playbook', area_id: 'auth', content: 'Fill #email then #password, click [type=submit].', contradicts: true, id: auth.id },
  ]);
  file = applyDeltas(file, 'run_4', [
    { type: 'playbook', area_id: 'auth', content: 'Fill #email then #password, click [type=submit].', contradicts: true, id: auth.id },
  ]);
  assert.equal(file.rows.find((r) => r.id === auth.id)?.contradicted_count, 2);

  saveMemory(p, file);
  const reloaded = loadMemory(p);
  assert.equal(reloaded.rows.length, 2);
});

test('renderMemoryPrompt formats playbooks + quirks and skips demoted rows', () => {
  const dir = tmp();
  const p = path.join(dir, 'mem.json');
  let file = loadMemory(p);
  file = applyDeltas(file, 'r1', [
    { type: 'playbook', area_id: 'auth', content: 'Click Sign In, fill form, submit.' },
    { type: 'quirk', area_id: 'dash', content: 'Stats race.', severity: 'minor', suggested_fix: 'Retry once.' },
  ]);
  // Demote the playbook
  const pb = file.rows.find((r) => r.type === 'playbook')!;
  pb.contradicted_count = 2;

  const out = renderMemoryPrompt(file);
  assert.match(out, /Prior knowledge/);
  assert.match(out, /Known quirks/);
  assert.match(out, /Stats race/);
  assert.match(out, /suggested fix: Retry once/);
  // Demoted playbook should not appear
  assert.doesNotMatch(out, /Click Sign In/);
});

test('renderMemoryPrompt returns empty string when store is empty', () => {
  const file = loadMemory('/nonexistent.json');
  assert.equal(renderMemoryPrompt(file), '');
});
