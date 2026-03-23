import assert from 'node:assert/strict';
import test from 'node:test';

import type { Spec } from './types.js';
import { lintSpec } from './lint.js';

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
