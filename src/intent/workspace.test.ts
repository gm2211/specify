import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { initializeIntent, intentWorkspace } from './workspace.js';

test('initialization preserves instructions and hooks and reruns idempotently', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'specify-init-'));
  try {
    const agents = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agents, '# Team instructions\nKeep this exact text.');
    fs.mkdirSync(path.join(root, '.githooks'));
    fs.writeFileSync(path.join(root, '.githooks', 'pre-commit'), 'existing hook');
    initializeIntent(root);
    const first = fs.readFileSync(agents, 'utf8');
    assert.ok(first.startsWith('# Team instructions\nKeep this exact text.\n'));
    assert.match(first, /Never weaken requirements/);
    assert.ok(fs.statSync(path.join(root, 'specify.intent', 'records')).isDirectory());
    initializeIntent(root);
    assert.equal(fs.readFileSync(agents, 'utf8'), first);
    assert.equal(
      fs.readFileSync(path.join(root, '.githooks', 'pre-commit'), 'utf8'),
      'existing hook',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('initialization refuses escaping packs, symlinks, and broken instruction markers', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'specify-init-'));
  try {
    assert.throws(() => intentWorkspace(root, '../outside'), /inside/);
    assert.throws(() => intentWorkspace(root, '.'), /inside/);
    fs.symlinkSync(tmpdir(), path.join(root, 'linked'));
    assert.throws(() => initializeIntent(root, 'linked/pack'), /symlink/);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '<!-- specify:begin:intent-workflow -->');
    assert.throws(() => initializeIntent(root), /Malformed/);
    fs.rmSync(path.join(root, 'AGENTS.md'));
    fs.writeFileSync(path.join(root, 'original.md'), 'original');
    fs.symlinkSync(path.join(root, 'original.md'), path.join(root, 'AGENTS.md'));
    assert.throws(() => initializeIntent(root), /symlink/);
    assert.equal(fs.readFileSync(path.join(root, 'original.md'), 'utf8'), 'original');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
