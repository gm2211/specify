import assert from 'node:assert/strict';
import test from 'node:test';

import type { Spec } from './types.js';
import { lintPath, lintSpec } from './lint.js';
import { specToYaml } from './parser.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-lint-dir-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

test('lintSpec detects duplicate area IDs', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
      { id: 'auth', name: 'Auth Dup', behaviors: [{ id: 'logout', description: 'User can log out' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'duplicate-area-id'));
});

test('lintSpec detects duplicate behavior IDs within an area', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      {
        id: 'auth',
        name: 'Auth',
        behaviors: [
          { id: 'login', description: 'User can log in' },
          { id: 'login', description: 'User can log in again' },
        ],
      },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'duplicate-behavior-id'));
});

test('lintSpec detects empty behavior descriptions', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: '   ' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'empty-behavior-description'));
});

test('lintSpec warns about ambiguous behavior IDs across areas', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'submit', description: 'Submit login form' }] },
      { id: 'settings', name: 'Settings', behaviors: [{ id: 'submit', description: 'Submit settings form' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'ambiguous-behavior-id'));
});

test('lintSpec returns no errors for a valid spec', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.equal(errors.length, 0);
});

test('lintPath validates composed directory specs', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), [
      'version: "2"',
      'name: Directory Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - areas/auth.yaml',
      '',
    ].join('\n'));
    writeFile(path.join(dir, 'areas', 'auth.yaml'), [
      'id: auth',
      'name: Auth',
      'behaviors:',
      '  - id: login',
      '    description: User can log in',
      '',
    ].join('\n'));

    assert.deepEqual(lintPath(dir), { valid: true, errors: [] });
  } finally {
    cleanup();
  }
});

test('lintPath reports composed directory duplicate sources', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), [
      'version: "2"',
      'name: Directory Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - areas/a.yaml',
      '  - areas/b.yaml',
      '',
    ].join('\n'));
    writeFile(path.join(dir, 'areas', 'a.yaml'), 'id: auth\nname: Auth\nbehaviors:\n  - id: login\n    description: Login\n');
    writeFile(path.join(dir, 'areas', 'b.yaml'), 'id: auth\nname: Duplicate\nbehaviors:\n  - id: logout\n    description: Logout\n');

    const result = lintPath(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) =>
      error.rule === 'composition' &&
      error.message.includes('Duplicate area ID "auth"') &&
      error.message.includes('a.yaml') &&
      error.message.includes('b.yaml'),
    ));
  } finally {
    cleanup();
  }
});

test('lintPath warns when a single-file spec is large enough to split', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'app.spec.yaml');
    const spec: Spec = {
      version: '2',
      name: 'Large Single File',
      target: { type: 'web', url: 'http://localhost:3000' },
      areas: [
        {
          id: 'huge',
          name: 'Huge',
          behaviors: Array.from({ length: 121 }, (_, i) => ({
            id: `behavior-${i}`,
            description: `Behavior ${i} works`,
          })),
        },
      ],
    };
    writeFile(specPath, specToYaml(spec));

    const result = lintPath(specPath);

    assert.equal(result.valid, true);
    assert.ok(result.errors.some((error) =>
      error.rule === 'oversized-single-file-spec' &&
      error.severity === 'warning' &&
      error.message.includes('specify spec split'),
    ));
  } finally {
    cleanup();
  }
});

function makeAuthSpec(): Spec {
  return {
    version: '2',
    name: 'Auth Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
    ],
  };
}

test('lintPath skips dangling-learned-state entirely when there is no .specify dir', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'dangling-learned-state'));
  } finally {
    cleanup();
  }
});

test('lintPath warns about a confidence.json row for a renamed/removed behavior', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, '.specify', 'confidence.json'), JSON.stringify({
      version: 1,
      rows: {
        login: { accepts: 3, overrides: 0, lastUpdatedAt: '2026-01-01T00:00:00Z' },
        signin: { accepts: 1, overrides: 0, lastUpdatedAt: '2026-01-01T00:00:00Z' },
      },
    }));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'dangling-learned-state');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warning');
    assert.ok(warnings[0].message.includes('signin'));
    assert.equal(result.valid, true, 'warnings alone do not invalidate the spec');
  } finally {
    cleanup();
  }
});

test('lintPath warns about a dangling observation scope', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    fs.mkdirSync(path.join(dir, '.specify'), { recursive: true });
    writeFile(path.join(dir, 'specify.observations.yaml'), [
      'version: 1',
      'observations:',
      '  - id: obs-1',
      '    description: Known quirk',
      '    area_id: auth',
      '    behavior_id: login',
      '    source: user_feedback',
      '  - id: obs-2',
      '    description: Orphaned by rename',
      '    area_id: auth',
      '    behavior_id: signin',
      '    source: user_feedback',
      '',
    ].join('\n'));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'dangling-learned-state');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('obs-2'));
  } finally {
    cleanup();
  }
});

test('lintPath warns about a dangling memory-store row', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, '.specify', 'memory', 'myspec', 'web_localhost.json'), JSON.stringify({
      version: 1,
      spec_id: 'myspec',
      target_key: 'web_localhost',
      rows: [
        { id: 'mem_1', type: 'playbook', area_id: 'auth', behavior_id: 'login', content: 'click sign in', contradicted_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'mem_2', type: 'playbook', area_id: 'auth', behavior_id: 'signin', content: 'stale playbook', contradicted_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ],
    }));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'dangling-learned-state');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('mem_2'));
  } finally {
    cleanup();
  }
});

test('lintPath reports no dangling-learned-state warnings once ids match the spec', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, '.specify', 'confidence.json'), JSON.stringify({
      version: 1,
      rows: { login: { accepts: 3, overrides: 0, lastUpdatedAt: '2026-01-01T00:00:00Z' } },
    }));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'dangling-learned-state'));
  } finally {
    cleanup();
  }
});

test('lintPath does not warn about aggregate size for directory specs', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), [
      'version: "2"',
      'name: Directory Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - areas/huge.yaml',
      '',
    ].join('\n'));
    const behaviors = Array.from({ length: 121 }, (_, i) => [
      `  - id: behavior-${i}`,
      `    description: Behavior ${i} works`,
    ].join('\n')).join('\n');
    writeFile(path.join(dir, 'areas', 'huge.yaml'), [
      'id: huge',
      'name: Huge',
      'behaviors:',
      behaviors,
      '',
    ].join('\n'));

    const result = lintPath(dir);

    assert.equal(result.valid, true);
    assert.ok(!result.errors.some((error) => error.rule === 'oversized-single-file-spec'));
  } finally {
    cleanup();
  }
});
