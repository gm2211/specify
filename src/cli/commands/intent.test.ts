import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../index.js', import.meta.url));
const record = {
  id: 'keep-user-intent',
  statement: 'User decisions persist across agent sessions.',
  kind: 'decision',
  source: { text: 'Keep tracking what I tell agents.', reference: 'test conversation' },
  appliesTo: [],
};

test('CLI captures conversation-only intent, gates current work, and survives Git checkout', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'intent-cli-'));
  const checkout = root + '-checkout';
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const run = (args: string[], input?: unknown, cwd = root) =>
    spawnSync(process.execPath, [cli, 'intent', ...args, '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      input: input === undefined ? undefined : JSON.stringify(input),
    });
  try {
    git('init');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(root, 'app.txt'), 'existing behavior\n');
    git('add', '.');
    git('commit', '-m', 'Initial fixture');
    const base = git('rev-parse', 'HEAD');
    assert.equal(run(['init']).status, 0);
    const captured = run(['capture', '--input', '-'], record);
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(JSON.parse(captured.stdout).record.source.text, record.source.text);
    assert.equal(run(['capture', '--input', '-'], record).status, 10);
    const context = run(['context', '--query', 'unrelated words']);
    assert.equal(JSON.parse(context.stdout).records[0].id, record.id);
    const missing = run(['check', '--base', base]);
    assert.equal(missing.status, 1, missing.stderr);
    const files: string[] = JSON.parse(missing.stdout).files;
    assert.ok(files.includes('specify.intent/records/keep-user-intent.json'));
    const review = {
      summary: 'Capture intent without changing app behavior.',
      files: files.map((file) => ({
        path: file,
        intentIds: [record.id],
        outcome: 'changed',
        reason: 'Persist intent and teach future agents to retrieve it.',
      })),
    };
    const reconciled = run(['reconcile', '--base', base, '--input', '-'], review);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.equal(run(['check', '--base', base]).status, 0);
    git('add', '.');
    git('commit', '-m', 'Capture intent');
    git('clone', '--quiet', root, checkout);
    const cloned = run(['check', '--base', base], undefined, checkout);
    assert.equal(cloned.status, 0, cloned.stderr || cloned.stdout);
    fs.appendFileSync(path.join(root, 'app.txt'), 'new behavior\n');
    const stale = run(['check', '--base', base]);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /stale|Missing file review/);
    assert.equal(run(['check']).status, 10);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
