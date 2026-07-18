import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { BehaviorResult, Spec } from './types.js';
import { mergeResultsById, scopedSpec } from './scope.js';

function spec(): Spec {
  return {
    version: '2',
    name: 'demo',
    target: { type: 'web', url: 'http://localhost' },
    areas: [
      {
        id: 'checkout',
        name: 'Checkout',
        behaviors: [
          { id: 'apply-coupon', description: 'applying a valid coupon reduces the total' },
          { id: 'free-shipping', description: 'orders over $50 ship free' },
        ],
      },
      {
        id: 'auth',
        name: 'Auth',
        behaviors: [{ id: 'login', description: 'a valid login succeeds' }],
      },
    ],
  };
}

test('scopedSpec: keeps only listed behavior ids, drops empty areas', () => {
  const scoped = scopedSpec(spec(), ['checkout/free-shipping']);
  assert.equal(scoped.areas.length, 1);
  assert.equal(scoped.areas[0].id, 'checkout');
  assert.equal(scoped.areas[0].behaviors.length, 1);
  assert.equal(scoped.areas[0].behaviors[0].id, 'free-shipping');
});

test('scopedSpec: multiple ids across multiple areas', () => {
  const scoped = scopedSpec(spec(), ['checkout/apply-coupon', 'auth/login']);
  assert.equal(scoped.areas.length, 2);
  const ids = scoped.areas.flatMap((a) => a.behaviors.map((b) => `${a.id}/${b.id}`));
  assert.deepEqual(ids.sort(), ['auth/login', 'checkout/apply-coupon']);
});

test('scopedSpec: no matching ids yields no areas', () => {
  const scoped = scopedSpec(spec(), ['nope/nothing']);
  assert.deepEqual(scoped.areas, []);
});

test('mergeResultsById: overrides replace base entries by id, preserving base order', () => {
  const base: BehaviorResult[] = [
    { id: 'a/1', description: 'x', status: 'passed' },
    { id: 'a/2', description: 'y', status: 'passed' },
  ];
  const overrides: BehaviorResult[] = [{ id: 'a/2', description: 'y', status: 'failed' }];
  const merged = mergeResultsById(base, overrides);
  assert.deepEqual(merged.map((r) => [r.id, r.status]), [
    ['a/1', 'passed'],
    ['a/2', 'failed'],
  ]);
});

test('mergeResultsById: overrides for new ids are appended', () => {
  const base: BehaviorResult[] = [{ id: 'a/1', description: 'x', status: 'passed' }];
  const overrides: BehaviorResult[] = [{ id: 'a/2', description: 'y', status: 'failed' }];
  const merged = mergeResultsById(base, overrides);
  assert.deepEqual(merged.map((r) => r.id), ['a/1', 'a/2']);
});
