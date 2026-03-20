import assert from 'node:assert/strict';
import test from 'node:test';

test('importing generateSpec does not trigger side-effect CLI execution', async () => {
  // Before the fix, `import('generator.js')` would call `generate()` at module
  // load, which calls `findLatestCapture()` and `process.exit(1)` when no
  // `captures/` directory exists.  The fix must guard the top-level call so
  // that only direct execution triggers it.

  // If the side-effect fires, process.exit will be called — intercept it.
  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = ((code?: number) => { exitCalled = true; }) as never;

  try {
    const mod = await import('./generator.js');
    assert.ok(typeof mod.generateSpec === 'function', 'generateSpec should be exported');
    assert.ok(!exitCalled, 'importing generator must not call process.exit (side-effect generate() fired)');
  } finally {
    process.exit = originalExit;
  }
});
