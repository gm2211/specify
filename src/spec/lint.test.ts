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
      {
        id: 'auth',
        name: 'Auth Dup',
        behaviors: [{ id: 'logout', description: 'User can log out' }],
      },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some((err) => err.rule === 'duplicate-area-id'));
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
  assert.ok(errors.some((err) => err.rule === 'duplicate-behavior-id'));
});

test('lintSpec detects empty behavior descriptions', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [{ id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: '   ' }] }],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some((err) => err.rule === 'empty-behavior-description'));
});

test('lintSpec warns about ambiguous behavior IDs across areas', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'submit', description: 'Submit login form' }] },
      {
        id: 'settings',
        name: 'Settings',
        behaviors: [{ id: 'submit', description: 'Submit settings form' }],
      },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some((err) => err.rule === 'ambiguous-behavior-id'));
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
    writeFile(
      path.join(dir, 'spec.yaml'),
      [
        'version: "2"',
        'name: Directory Spec',
        'target:',
        '  type: web',
        '  url: http://localhost:3000',
        'areas:',
        '  - areas/auth.yaml',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(dir, 'areas', 'auth.yaml'),
      [
        'id: auth',
        'name: Auth',
        'behaviors:',
        '  - id: login',
        '    description: User can log in',
        '',
      ].join('\n'),
    );

    assert.deepEqual(lintPath(dir), { valid: true, errors: [] });
  } finally {
    cleanup();
  }
});

test('lintPath reports composed directory duplicate sources', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(
      path.join(dir, 'spec.yaml'),
      [
        'version: "2"',
        'name: Directory Spec',
        'target:',
        '  type: web',
        '  url: http://localhost:3000',
        'areas:',
        '  - areas/a.yaml',
        '  - areas/b.yaml',
        '',
      ].join('\n'),
    );
    writeFile(
      path.join(dir, 'areas', 'a.yaml'),
      'id: auth\nname: Auth\nbehaviors:\n  - id: login\n    description: Login\n',
    );
    writeFile(
      path.join(dir, 'areas', 'b.yaml'),
      'id: auth\nname: Duplicate\nbehaviors:\n  - id: logout\n    description: Logout\n',
    );

    const result = lintPath(dir);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.rule === 'composition' &&
          error.message.includes('Duplicate area ID "auth"') &&
          error.message.includes('a.yaml') &&
          error.message.includes('b.yaml'),
      ),
    );
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
    assert.ok(
      result.errors.some(
        (error) =>
          error.rule === 'oversized-single-file-spec' &&
          error.severity === 'warning' &&
          error.message.includes('specify spec split'),
      ),
    );
  } finally {
    cleanup();
  }
});

test('lintPath fails when a single-file spec is past the hard size limit', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'app.spec.yaml');
    const spec: Spec = {
      version: '2',
      name: 'Unreviewable Single File',
      target: { type: 'web', url: 'http://localhost:3000' },
      areas: [
        {
          id: 'huge',
          name: 'Huge',
          behaviors: Array.from({ length: 241 }, (_, i) => ({
            id: `behavior-${i}`,
            description: `Behavior ${i} works`,
          })),
        },
      ],
    };
    writeFile(specPath, specToYaml(spec));

    const result = lintPath(specPath);

    assert.equal(result.valid, false);
    const finding = result.errors.find((error) => error.rule === 'oversized-single-file-spec');
    assert.ok(finding);
    assert.equal(finding.severity, 'error');
    assert.ok(finding.message.includes('241 behaviors exceeds 240'));
    assert.ok(finding.message.includes('specify spec split'));
  } finally {
    cleanup();
  }
});

test('lintPath does not warn about aggregate size for directory specs', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(
      path.join(dir, 'spec.yaml'),
      [
        'version: "2"',
        'name: Directory Spec',
        'target:',
        '  type: web',
        '  url: http://localhost:3000',
        'areas:',
        '  - areas/huge.yaml',
        '',
      ].join('\n'),
    );
    const behaviors = Array.from({ length: 121 }, (_, i) =>
      [`  - id: behavior-${i}`, `    description: Behavior ${i} works`].join('\n'),
    ).join('\n');
    writeFile(
      path.join(dir, 'areas', 'huge.yaml'),
      ['id: huge', 'name: Huge', 'behaviors:', behaviors, ''].join('\n'),
    );

    const result = lintPath(dir);

    assert.equal(result.valid, true);
    assert.ok(!result.errors.some((error) => error.rule === 'oversized-single-file-spec'));
  } finally {
    cleanup();
  }
});

test('lintPath ignores and preserves legacy sidecars', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(
      specPath,
      specToYaml({
        version: '2',
        name: 'Sidecar Compatibility',
        target: { type: 'web', url: 'http://localhost:3000' },
        areas: [
          {
            id: 'auth',
            name: 'Auth',
            behaviors: [{ id: 'login', description: 'User can log in' }],
          },
        ],
      }),
    );

    const sidecars = new Map([
      ['.specify/confidence.json', '{invalid json'],
      ['specify.observations.yaml', 'observations: [invalid yaml'],
      ['.specify/memory/legacy/target.json', '{"rows":[{"behavior_id":"removed"}]}'],
      ['specify.formulas.yaml', 'formulas: [\n  - id: invalid'],
      ['specify.quint.yaml', 'version: 1\nspecs: []\n'],
    ]);
    for (const [relativePath, contents] of sidecars) {
      writeFile(path.join(dir, relativePath), contents);
    }

    assert.deepEqual(lintPath(specPath), { valid: true, errors: [] });
    for (const [relativePath, contents] of sidecars) {
      assert.equal(fs.readFileSync(path.join(dir, relativePath), 'utf-8'), contents);
    }
  } finally {
    cleanup();
  }
});
