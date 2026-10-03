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
    'formal check',
    'spec init',
    'spec check',
    'spec lint',
    'spec split',
    'spec context',
    'spec guide',
    'schema',
    'mcp',
  ]);
  assert.match(run(['--version']).stdout, /^0\.5\.\d+\n$/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /maintained specs/);
  for (const removed of [
    'capture',
    'create',
    'human',
    'review',
    'daemon',
    'deploy',
    'verify',
    'prove',
    'intent',
  ]) {
    const result = run([removed]);
    assert.equal(result.status, 10, result.stderr);
    assert.match(result.stdout, /migration/);
  }
});

test('CLI fails closed on removed, unknown, duplicate and malformed options', () => {
  for (const args of [
    ['mcp', '--http'],
    ['spec', 'check'],
    ['verify', '--url', 'http://example.test'],
    ['spec', 'lint', '--spec'],
    ['spec', 'lint', '--spec', 'a', '--spec', 'b'],
    ['--format', 'garbage', 'schema', 'spec'],
    ['schema', 'commands', '--format'],
    ['formal', 'check', '--timeout-ms', '0'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 10, args.join(' '));
    assert.ok(JSON.parse(result.stdout).error);
  }
});

test('formal CLI reports unlinked requirements and rejects invalid timeout values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-formal-cli-'));
  try {
    const spec = join(dir, 'contract.json');
    writeFileSync(spec, JSON.stringify(contract));
    const result = run(['formal', 'check', '--spec', spec]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, false);
    assert.equal(report.scope, 'formal-models-only');
    assert.deepEqual(report.unlinkedBehaviorIds, ['account/login', 'account/logout']);
    for (const value of ['0', '1.5', '600001', '10seconds']) {
      const invalid = run(['formal', 'check', '--spec', spec, '--timeout-ms', value]);
      assert.equal(invalid.status, 10, value);
      assert.match(invalid.stderr, /timeout-ms/);
    }
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
