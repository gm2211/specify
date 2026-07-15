import assert from 'node:assert/strict';
import test from 'node:test';

import type { Spec } from './types.js';
import { lintPath, lintSpec } from './lint.js';
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
