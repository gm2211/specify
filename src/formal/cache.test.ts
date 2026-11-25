import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLimit } from './cache.js';

test('mapLimit bounds concurrency and keeps input order', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 2, async (ms) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running--;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 10, 40, 2, 20, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 4, async (x: number) => x), []);
});
