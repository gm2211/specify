import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
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

test('overview/no-args-returns-json-manifest exposes a typed discovery manifest', () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  const manifest: unknown = JSON.parse(result.stdout);
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
  assert.deepEqual(Object.keys(manifest).sort(), ['commands', 'exit_codes', 'global_options']);
  const payload = manifest as {
    commands: Array<{
      name: string;
      description: string;
      parameters: Array<{
        name: string;
        description: string;
        required: boolean;
        type: string;
      }>;
    }>;
    global_options: string[];
    exit_codes: Record<string, number>;
  };
  assert.ok(Array.isArray(payload.commands) && payload.commands.length > 0);
  for (const command of payload.commands) {
    assert.equal(typeof command.name, 'string');
    assert.ok(command.name.length > 0);
    assert.equal(typeof command.description, 'string');
    assert.ok(Array.isArray(command.parameters));
    for (const option of command.parameters) {
      assert.deepEqual(Object.keys(option).sort(), ['description', 'name', 'required', 'type']);
      assert.equal(typeof option.name, 'string');
      assert.equal(typeof option.description, 'string');
      assert.equal(typeof option.required, 'boolean');
      assert.ok(['string', 'boolean'].includes(option.type));
    }
  }
  assert.deepEqual(
    payload.commands.map(({ name }) => name),
    [
      'formal check',
      'spec init',
      'spec check',
      'spec lint',
      'spec split',
      'spec context',
      'spec guide',
      'view',
      'schema',
      'mcp',
    ],
  );
  assert.deepEqual(payload.global_options, [
    '--format',
    '--output-format',
    '--fields',
    '--json',
    '--quiet',
    '-q',
  ]);
  assert.deepEqual(payload.exit_codes, { SUCCESS: 0, REVIEW_REQUIRED: 1, PARSE_ERROR: 10 });
  assert.ok(
    payload.commands
      .find(({ name }) => name === 'spec check')
      ?.parameters.some(({ name, required }) => name === '--base' && required),
  );
  assert.ok(
    payload.commands
      .find(({ name }) => name === 'spec split')
      ?.parameters.some(({ name, type }) => name === '--force' && type === 'boolean'),
  );
});

test('overview/help-flag-shows-text supports both help flags', () => {
  for (const flag of ['--help', '-h']) {
    const help = run([flag]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /maintained specs/);
    assert.match(help.stdout, /spec check/);
  }
});

test('overview/version-flag-shows-version supports both version flags', () => {
  for (const flag of ['--version', '-V']) {
    const version = run([flag]);
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^0\.8\.\d+\n$/);
  }
});

test('overview/unknown-command-fails points to migration guidance', () => {
  for (const command of [
    'unknown-command',
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
    const result = run([command]);
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

test('view CLI prints its discovered URL, serves the spec, and shuts down on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-view-cli-'));
  const spec = join(dir, 'contract.json');
  writeFileSync(spec, JSON.stringify(contract));
  const child = spawn(process.execPath, [cli, 'view', '--spec', spec, '--no-open']);
  let output = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Viewer URL not printed: ${output}`)),
        5000,
      );
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        const match = /Specify viewer: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Viewer exited before printing URL (${code}): ${output}`));
      });
    });
    const response = await fetch(`${url}spec`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.name, 'Fixture');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('view CLI rejects malformed port values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-view-port-'));
  const spec = join(dir, 'contract.json');
  writeFileSync(spec, JSON.stringify(contract));
  try {
    const result = run(['view', '--spec', spec, '--port', '65536', '--no-open']);
    assert.equal(result.status, 10);
    assert.match(result.stderr, /port must be an integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
