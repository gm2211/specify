import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { specInit } from './spec-init.js';

test('init preserves instructions, retires owned legacy block, and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-init-'));
  try {
    const spec = join(dir, 'app.spec.json');
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(
      spec,
      JSON.stringify({
        version: '2',
        name: 'App',
        target: { type: 'cli', binary: 'app' },
        areas: [{ id: 'core', name: 'Core', behaviors: [{ id: 'works', description: 'Works' }] }],
      }),
    );
    writeFileSync(
      agents,
      '# Keep this\n<!-- specify:begin:intent-workflow -->\nobsolete commands\n<!-- specify:end:intent-workflow -->\nKeep this too\n',
    );
    const ctx = { outputFormat: 'json' as const, quiet: true };
    assert.equal(specInit({ spec, agents }, ctx), 0);
    const once = readFileSync(agents, 'utf8');
    assert.match(once, /^# Keep this/);
    assert.match(once, /Keep this too/);
    assert.doesNotMatch(once, /obsolete commands|intent-workflow/);
    assert.match(once, /source.text/);
    specInit({ spec, agents }, ctx);
    assert.equal(readFileSync(agents, 'utf8'), once);
    writeFileSync(agents, '<!-- specify:begin:spec-workflow -->');
    assert.throws(() => specInit({ spec, agents }, ctx), /Malformed/);
    rmSync(agents);
    symlinkSync(join(dir, 'missing'), agents);
    assert.throws(() => specInit({ spec, agents }, ctx), /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
