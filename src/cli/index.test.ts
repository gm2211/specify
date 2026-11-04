import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./index.js', import.meta.url));
function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('CLI manifest, help and version expose only init and formal check', () => {
  const manifest = run([]);
  assert.equal(manifest.status, 0, manifest.stderr);
  const names = JSON.parse(manifest.stdout).commands.map((c: { name: string }) => c.name);
  assert.deepEqual(names, ['init', 'formal check']);
  assert.match(run(['--version']).stdout, /^0\.8\.\d+\n$/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /OpenSpec/);
  for (const removed of [['spec', 'lint'], ['spec', 'init'], ['view'], ['mcp'], ['schema']]) {
    const result = run(removed);
    assert.equal(result.status, 10, removed.join(' '));
    assert.match(result.stdout, /migration-0\.8/);
  }
});

test('CLI fails closed on unknown, duplicate and malformed options', () => {
  for (const args of [
    ['formal', 'check', '--spec', 'x'],
    ['formal', 'check', '--root'],
    ['formal', 'check', '--root', 'a', '--root', 'b'],
    ['--format', 'garbage', 'formal', 'check'],
    ['formal', 'check', '--timeout-ms', '0'],
    ['formal', 'check', '--tool', 'tla'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 10, args.join(' '));
    assert.ok(JSON.parse(result.stdout).error);
  }
});

test('formal check prints JSON with unlinked requirements and a table for text output', () => {
  const dir = tempDir('specify-formal-cli-');
  try {
    mkdirSync(join(dir, 'openspec', 'specs', 'account'), { recursive: true });
    writeFileSync(
      join(dir, 'openspec', 'specs', 'account', 'spec.md'),
      '## Requirements\n\n### Requirement: Login\nThe system SHALL log in.\n',
    );
    const json = run(['formal', 'check', '--root', dir]);
    assert.equal(json.status, 1, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.valid, false);
    assert.deepEqual(report.unlinkedRequirementIds, ['account/Login']);
    const text = run(['formal', 'check', '--root', dir, '--format', 'text']);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /\| Requirement \| Check \| Expect \| Result \|/);
    assert.match(text.stdout, /- account\/Login/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init runs openspec init, creates formal/, and manages one AGENTS.md region', () => {
  const dir = tempDir('specify-init-');
  try {
    const fake = join(dir, 'fake-openspec');
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync('openspec-args', JSON.stringify(process.argv.slice(2)));\nfs.mkdirSync('openspec/specs', { recursive: true });\n`,
    );
    chmodSync(fake, 0o700);
    writeFileSync(
      join(dir, 'AGENTS.md'),
      '# Mine\n\n<!-- specify:begin:spec-workflow -->\nold\n<!-- specify:end:spec-workflow -->\n\nKeep me.\n',
    );
    const first = run(['init', '--root', dir, '--openspec-bin', fake, '--tools', 'none']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).openspec, 'initialized');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'openspec-args'), 'utf8')), [
      'init',
      '--tools',
      'none',
      '.',
    ]);
    assert.ok(existsSync(join(dir, 'formal', 'README.md')));

    const second = run(['init', '--root', dir, '--openspec-bin', fake]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).openspec, 'existing');

    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.equal(agents.split('<!-- specify:begin:formal-workflow -->').length, 2);
    assert.doesNotMatch(agents, /spec-workflow|\nold\n/);
    assert.match(agents, /^# Mine\n/);
    assert.match(agents, /Keep me\./);
    assert.match(agents, /expect=fails/);
    assert.match(agents, /Run `specify formal check`/);
    assert.match(
      readFileSync(join(dir, '.claude', 'skills', 'specify-formal-properties', 'SKILL.md'), 'utf8'),
      /name: specify-formal-properties/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init reports a failing openspec init without writing instructions', () => {
  const dir = tempDir('specify-init-fail-');
  try {
    const fake = join(dir, 'fake-openspec');
    writeFileSync(fake, `#!${process.execPath}\nprocess.exit(3);\n`);
    chmodSync(fake, 0o700);
    const result = run(['init', '--root', dir, '--openspec-bin', fake]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /status 3/);
    assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
