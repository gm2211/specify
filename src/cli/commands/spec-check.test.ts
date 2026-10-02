import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CliContext } from '../types.js';
import { specCheck } from './spec-check.js';

const spec = `version: '2'
name: Test Spec
description: Minimal test contract
target:
  type: cli
  binary: test
areas:
  - id: core
    name: Core
    behaviors:
      - id: works
        description: It works
`;

interface TestRepo {
  dir: string;
  base: string;
  cleanup: () => void;
  write: (relative: string, value: string) => void;
  git: (args: string[]) => string;
}

function makeRepo(): TestRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-spec-check-'));
  const write = (relative: string, value: string) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Spec Check Test']);
  git(['config', 'user.email', 'spec-check@example.test']);
  write('spec/spec.yaml', spec);
  write('src/app.ts', 'export const value = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return {
    dir,
    base: git(['rev-parse', 'HEAD']),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    write,
    git,
  };
}

async function run(repo: TestRepo, options: { spec?: string; base?: string; reason?: string }) {
  const oldCwd = process.cwd();
  process.chdir(repo.dir);
  const context: CliContext = { outputFormat: 'json', quiet: true };
  try {
    const code = await specCheck(
      {
        spec: options.spec ?? 'spec/spec.yaml',
        base: options.base ?? repo.base,
        reason: options.reason,
      },
      context,
    );
    return code;
  } finally {
    process.chdir(oldCwd);
  }
}

test('requires a reason for code-only changes and accepts nonblank author reason', async () => {
  const repo = makeRepo();
  try {
    repo.write('src/app.ts', 'export const value = 2;\n');
    assert.equal(await run(repo, {}), 1);
    assert.equal(await run(repo, { reason: 'Refactor only; no contract change.' }), 0);
  } finally {
    repo.cleanup();
  }
});

test('passes when selected spec file changes', async () => {
  const repo = makeRepo();
  try {
    repo.write('spec/spec.yaml', `${spec}\n# changed contract source\n`);
    assert.equal(await run(repo, {}), 0);
  } finally {
    repo.cleanup();
  }
});

test('directory spec only counts manifest and parser-reported source files', async () => {
  const repo = makeRepo();
  try {
    repo.write(
      'spec/spec.yaml',
      spec.replace(
        'areas:\n  - id: core\n    name: Core\n    behaviors:\n      - id: works\n        description: It works\n',
        'areas:\n  - areas/core.yaml\n',
      ),
    );
    repo.write(
      'spec/areas/core.yaml',
      `id: core\nname: Core\nbehaviors:\n  - id: works\n    description: It works\n`,
    );
    repo.git(['add', 'spec']);
    repo.git(['commit', '-qm', 'make directory spec']);
    const base = repo.git(['rev-parse', 'HEAD']);
    repo.write('spec/unrelated.txt', 'not a spec source\n');
    assert.equal(await run(repo, { base, spec: 'spec' }), 1);
    assert.equal(await run(repo, { base, spec: 'spec', reason: 'Documentation beside spec.' }), 0);
    repo.write(
      'spec/areas/core.yaml',
      `id: core\nname: Core\nbehaviors:\n  - id: works\n    description: Changed contract\n`,
    );
    assert.equal(await run(repo, { base, spec: 'spec' }), 0);
  } finally {
    repo.cleanup();
  }
});

test('invalid spec fails even when reason supplied; invalid base fails', async () => {
  const repo = makeRepo();
  try {
    repo.write('spec/spec.yaml', 'version: nope\n');
    assert.equal(await run(repo, { reason: 'I reviewed it.' }), 10);
    assert.equal(await run(repo, { base: 'missing-ref' }), 10);
  } finally {
    repo.cleanup();
  }
});

test('rejects spec paths outside repository', async () => {
  const repo = makeRepo();
  try {
    assert.equal(await run(repo, { spec: path.join(os.tmpdir(), 'outside-spec.yaml') }), 10);
  } finally {
    repo.cleanup();
  }
});
