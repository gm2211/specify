import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { checkIntentReview, getChangeSnapshot, reconcileIntent } from './review.js';

function repository(): { dir: string; cleanup: () => void; base: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-review-'));
  const run = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  run(['init', '-q']);
  run(['config', 'user.name', 'Review Test']);
  run(['config', 'user.email', 'review@example.test']);
  write(
    dir,
    'specify.spec/records/intent-alpha.json',
    JSON.stringify({
      id: 'intent-alpha',
      kind: 'decision',
      statement: 'Keep alpha',
      source: { text: 'test' },
      appliesTo: [],
    }),
  );
  write(dir, 'src/app.ts', 'export const value = 1;\n');
  write(dir, 'src/delete.ts', 'delete me\n');
  run(['add', '.']);
  run(['commit', '-qm', 'base']);
  const base = run(['rev-parse', 'HEAD']);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), base };
}

function write(root: string, relative: string, value: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function reviewInput(
  files: Array<{
    path: string;
    outcome?: 'preserved' | 'changed' | 'unmet' | 'none';
    intentIds?: string[];
  }>,
) {
  return {
    summary: 'Reviewed current changes',
    files: files.map((file) => ({
      path: file.path,
      intentIds: file.intentIds ?? ['intent-alpha'],
      outcome: file.outcome ?? 'changed',
      reason: 'Reviewed against intent',
    })),
  };
}

const opts = (dir: string, base: string) => ({
  root: dir,
  base,
  packPath: 'specify.spec',
  reviewPath: 'specify.spec/review.json',
});

test('accepts matching review and returns stable content fingerprint', async () => {
  const repo = repository();
  try {
    write(repo.dir, 'src/app.ts', 'export const value = 2;\n');
    const current = getChangeSnapshot(repo.dir, repo.base, 'specify.spec/review.json');
    assert.deepEqual(current.files, ['src/app.ts']);
    const result = await reconcileIntent(
      opts(repo.dir, repo.base),
      reviewInput([{ path: 'src/app.ts' }]),
    );
    assert.equal(result.valid, true);
    fs.chmodSync(path.join(repo.dir, 'src/app.ts'), 0o600);
    const check = await checkIntentReview(opts(repo.dir, repo.base));
    assert.equal(check.valid, true);
  } finally {
    repo.cleanup();
  }
});

test('rejects stale source and spec edits after reconciliation', async () => {
  const repo = repository();
  try {
    write(repo.dir, 'src/app.ts', 'export const value = 2;\n');
    await reconcileIntent(opts(repo.dir, repo.base), reviewInput([{ path: 'src/app.ts' }]));
    write(repo.dir, 'src/app.ts', 'export const value = 3;\n');
    const changed = await checkIntentReview(opts(repo.dir, repo.base));
    assert.equal(changed.valid, false);
    fs.writeFileSync(path.join(repo.dir, 'specify.spec/records/intent-alpha.json'), '{}');
    const changedPack = await checkIntentReview(opts(repo.dir, repo.base));
    assert.equal(changedPack.valid, false);
  } finally {
    repo.cleanup();
  }
});

test('snapshot includes untracked, deleted, staged, and mode changes', () => {
  const repo = repository();
  try {
    write(repo.dir, 'new.txt', 'new\n');
    write(repo.dir, 'src/app.ts', 'staged content\n');
    execFileSync('git', ['-C', repo.dir, 'add', 'src/app.ts']);
    fs.unlinkSync(path.join(repo.dir, 'src/delete.ts'));
    fs.chmodSync(path.join(repo.dir, 'specify.spec/records/intent-alpha.json'), 0o755);
    const first = getChangeSnapshot(repo.dir, repo.base, 'specify.spec/review.json');
    assert.deepEqual(first.files, [
      'new.txt',
      'specify.spec/records/intent-alpha.json',
      'src/app.ts',
      'src/delete.ts',
    ]);
    fs.chmodSync(path.join(repo.dir, 'specify.spec/records/intent-alpha.json'), 0o644);
    const second = getChangeSnapshot(repo.dir, repo.base, 'specify.spec/review.json');
    assert.notEqual(first.fingerprint, second.fingerprint);
  } finally {
    repo.cleanup();
  }
});

test('rejects missing, duplicate, unknown file reviews, invalid IDs, and none with IDs', async () => {
  const repo = repository();
  try {
    write(repo.dir, 'src/app.ts', 'changed\n');
    const cases = [
      reviewInput([]),
      reviewInput([{ path: 'src/app.ts' }, { path: 'src/app.ts' }]),
      reviewInput([{ path: 'other.ts' }]),
      reviewInput([{ path: 'src/app.ts', intentIds: ['missing'] }]),
      reviewInput([{ path: 'src/app.ts', outcome: 'none' }]),
      reviewInput([{ path: 'src/app.ts', outcome: 'none', intentIds: [] }]),
    ];
    for (const input of cases)
      await assert.rejects(reconcileIntent(opts(repo.dir, repo.base), input));
    assert.equal(fs.existsSync(path.join(repo.dir, 'specify.spec/review.json')), false);
  } finally {
    repo.cleanup();
  }
});

test('rejects a file edited in both the index and working tree', () => {
  const repo = repository();
  try {
    write(repo.dir, 'src/app.ts', 'staged version\n');
    execFileSync('git', ['-C', repo.dir, 'add', 'src/app.ts']);
    write(repo.dir, 'src/app.ts', 'different working version\n');
    assert.throws(
      () => getChangeSnapshot(repo.dir, repo.base, 'specify.spec/review.json'),
      /partially staged/,
    );
  } finally {
    repo.cleanup();
  }
});

test('rejects invalid or non-ancestor base and reports unmet requirements as invalid', async () => {
  const repo = repository();
  try {
    assert.throws(() => getChangeSnapshot(repo.dir, 'missing-ref', 'specify.spec/review.json'));
    const unrelated = execFileSync(
      'git',
      ['-C', repo.dir, 'commit-tree', `${repo.base}^{tree}`, '-m', 'unrelated'],
      { encoding: 'utf8' },
    ).trim();
    assert.throws(
      () => getChangeSnapshot(repo.dir, unrelated, 'specify.spec/review.json'),
      /ancestor/,
    );
    write(repo.dir, 'src/app.ts', 'changed\n');
    const input = {
      ...reviewInput([{ path: 'src/app.ts', outcome: 'unmet' }]),
      unmet: [{ intentId: 'intent-alpha', reason: 'Still missing' }],
    };
    const saved = await reconcileIntent(opts(repo.dir, repo.base), input);
    assert.equal(saved.valid, false);
    assert.match(saved.errors.join(' '), /unmet/i);
  } finally {
    repo.cleanup();
  }
});
