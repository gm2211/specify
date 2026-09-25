import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./index.js', import.meta.url));
function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 15000 });
}

const contract = {
  version: '2',
  name: 'Fixture',
  target: { type: 'cli', binary: 'unused' },
  areas: [
    {
      id: 'account',
      name: 'Account',
      behaviors: [
        { id: 'login', description: 'Valid credentials open a session' },
        { id: 'logout', description: 'Logout closes the session' },
      ],
    },
  ],
};

test('CLI manifest, help and version expose only the reduced product', () => {
  const manifest = run([]);
  assert.equal(manifest.status, 0, manifest.stderr);
  const names = JSON.parse(manifest.stdout).commands.map((c: { name: string }) => c.name);
  assert.deepEqual(names, [
    'spec lint',
    'spec split',
    'spec context',
    'spec guide',
    'schema',
    'verify',
    'prove',
    'mcp',
  ]);
  assert.match(run(['--version']).stdout, /^0\.3\.\d+\n$/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /external evidence/);
  for (const removed of ['capture', 'create', 'human', 'review', 'daemon', 'deploy']) {
    const result = run([removed]);
    assert.equal(result.status, 10, result.stderr);
    assert.match(result.stdout, /migration/);
  }
});

test('CLI fails closed on removed, unknown, duplicate and malformed options', () => {
  for (const args of [
    ['mcp', '--http'],
    ['verify', '--url', 'http://example.test'],
    ['spec', 'lint', '--spec'],
    ['spec', 'lint', '--spec', 'a', '--spec', 'b'],
    ['--format', 'garbage', 'schema', 'spec'],
    ['schema', 'commands', '--format'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 10, args.join(' '));
    assert.ok(JSON.parse(result.stdout).error);
  }
});

test('results CLI gates external coverage and preserves input without model credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-results-cli-'));
  try {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(contract));
    const report = join(dir, 'results.json');
    const check = (results: unknown[]) => {
      writeFileSync(report, JSON.stringify({ pass: true, summary: { passed: 999 }, results }));
      return run(['verify', '--report', report], dir);
    };
    const row = (id: string, status = 'passed') => ({ id: `account/${id}`, status });
    const passed = check([row('login'), row('logout')]);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).summary.passed, 2);
    assert.equal(check([row('login')]).status, 2);
    assert.equal(check([row('login'), row('logout', 'skipped')]).status, 2);
    assert.equal(check([row('login', 'failed')]).status, 1);
    assert.equal(check([row('login'), row('login')]).status, 10);
    assert.equal(check([row('unknown')]).status, 10);
    for (const mode of ['agent', 'auto', 'formal']) {
      assert.equal(run(['verify', '--mode', mode], dir).status, 10);
    }
    assert.equal(run(['verify'], dir).status, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contract lint accepts stdin and discovery refuses ambiguous contracts', () => {
  const stdin = spawnSync(process.execPath, [cli, 'spec', 'lint', '--spec', '-'], {
    input: JSON.stringify(contract),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(stdin.status, 0, stdin.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'specify-discovery-cli-'));
  try {
    writeFileSync(join(dir, 'one.spec.json'), JSON.stringify(contract));
    writeFileSync(join(dir, 'two.spec.json'), JSON.stringify(contract));
    const result = run(['spec', 'lint'], dir);
    assert.equal(result.status, 10);
    assert.match(result.stderr, /one.spec.json/);
    assert.match(result.stderr, /two.spec.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
