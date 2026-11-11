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

test('CLI manifest, help and version expose the supported commands', () => {
  const manifest = run([]);
  assert.equal(manifest.status, 0, manifest.stderr);
  const names = JSON.parse(manifest.stdout).commands.map((c: { name: string }) => c.name);
  assert.deepEqual(names, ['init', 'formal check', 'gate', 'lock', 'trace export']);
  assert.match(run(['--version']).stdout, /^0\.9\.\d+\n$/);
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
    ['gate', '--policy', 'loose'],
    ['gate', '--hook', 'commit'],
    ['gate', '--base', 'a b'],
    ['trace', 'export', '--traces', '0'],
    ['trace', 'import'],
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
    assert.match(agents, /Run `specify gate`/);
    assert.match(agents, /Formal: none/);

    // The first run initialized OpenSpec, so the project starts strict; later runs keep the file.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'formal', 'specify.json'), 'utf8')), {
      policy: 'strict',
      testReports: [],
    });
    assert.equal(JSON.parse(first.stdout).hooks.stop, undefined, 'no Claude hook for --tools none');
    assert.equal(JSON.parse(second.stdout).hooks.prePush, 'skipped-no-git');
    const settings = join(dir, '.claude', 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({ env: { A: '1' }, hooks: JSON.parse(readFileSync(settings, 'utf8')).hooks }),
    );
    assert.equal(run(['init', '--root', dir, '--openspec-bin', fake]).status, 0);
    const merged = JSON.parse(readFileSync(settings, 'utf8'));
    assert.deepEqual(merged.env, { A: '1' });
    assert.deepEqual(merged.hooks.Stop, [
      {
        hooks: [{ type: 'command', command: 'specify gate --hook stop --changed --skip-verify' }],
      },
    ]);
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

function gateProject(dir: string, formalLine: string): void {
  mkdirSync(join(dir, 'openspec', 'specs', 'account'), { recursive: true });
  writeFileSync(
    join(dir, 'openspec', 'specs', 'account', 'spec.md'),
    `## Requirements\n\n### Requirement: Login\nThe system SHALL log in.\n\n${formalLine}\n`,
  );
  mkdirSync(join(dir, 'formal'), { recursive: true });
  writeFileSync(join(dir, 'formal', 'specify.json'), '{"policy":"strict"}');
}

test('gate and lock: a waived project passes once locked, and an existing project gets warn and a pre-push hook', () => {
  const dir = tempDir('specify-gate-cli-');
  try {
    gateProject(dir, '- Formal: none (covered by tests)');
    const unlocked = run(['gate', '--root', dir, '--format', 'text']);
    assert.equal(unlocked.status, 1, unlocked.stderr);
    assert.match(unlocked.stdout, /Gate closed \(1\):\n- formal\/specify\.lock is missing/);
    const locked = run(['lock', '--root', dir]);
    assert.equal(locked.status, 0, locked.stderr);
    assert.equal(JSON.parse(locked.stdout).requirements, 1);
    const open = run(['gate', '--root', dir]);
    assert.equal(open.status, 0, open.stdout);
    assert.equal(JSON.parse(open.stdout).valid, true);

    rmSync(join(dir, 'formal', 'specify.json'));
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
    const init = run(['init', '--root', dir, '--skip-openspec', '--tools', 'none']);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).hooks.prePush, 'installed');
    assert.match(
      readFileSync(join(dir, '.git', 'hooks', 'pre-push'), 'utf8'),
      /exec specify gate --hook pre-push --changed --skip-verify/,
    );
    assert.equal(run(['init', '--root', dir, '--skip-openspec']).status, 0);
    const again = run(['init', '--root', dir, '--skip-openspec', '--tools', 'none']);
    assert.equal(JSON.parse(again.stdout).hooks.prePush, 'present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate --hook stop: exit 2 with the report on stderr, and silent once the hook already fired', () => {
  const dir = tempDir('specify-gate-hook-');
  try {
    gateProject(dir, '');
    const blocked = spawnSync(process.execPath, [cli, 'gate', '--root', dir, '--hook', 'stop'], {
      encoding: 'utf8',
      input: '{"stop_hook_active":false}',
    });
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stdout, '');
    assert.match(blocked.stderr, /account\/Login: no Formal link and no waiver/);
    assert.match(blocked.stderr, /Do not weaken a property/);
    const second = spawnSync(process.execPath, [cli, 'gate', '--root', dir, '--hook', 'stop'], {
      encoding: 'utf8',
      input: '{"stop_hook_active":true}',
    });
    assert.equal(second.status, 0);
    const push = spawnSync(process.execPath, [cli, 'gate', '--root', dir, '--hook', 'pre-push'], {
      encoding: 'utf8',
      input: '',
    });
    assert.equal(push.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
