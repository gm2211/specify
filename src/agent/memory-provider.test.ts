import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileBackedMemoryProvider,
  defaultMemoryProvider,
  scopeTargetKey,
  type MemoryScope,
} from './memory-provider.js';

function tmpSpec(): { specPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-mem-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { specPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('FileBackedMemoryProvider: round-trip read/write/prefetch', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const provider = new FileBackedMemoryProvider();
    const scope: MemoryScope = {
      specPath,
      specId: 'demo',
      target: { type: 'web', url: 'https://app.example.com' },
    };

    const empty = await provider.read(scope);
    assert.equal(empty.rows.length, 0);

    const written = await provider.write(scope, 'run_1', [
      {
        type: 'playbook',
        content: 'To verify login here, click #signin then wait for /dashboard.',
        area_id: 'auth',
        behavior_id: 'login-redirect',
      },
      {
        type: 'quirk',
        content: 'Header race: nav appears before fonts load.',
        severity: 'minor',
      },
    ]);
    assert.equal(written.rows.length, 2);

    const reloaded = await provider.read(scope);
    assert.equal(reloaded.rows.length, 2);
    assert.equal(reloaded.spec_id, 'demo');
    assert.equal(reloaded.target_key, scopeTargetKey(scope));

    const prompt = await provider.prefetch(scope);
    assert.match(prompt, /Known playbooks/);
    assert.match(prompt, /Known quirks/);
    assert.match(prompt, /click #signin/);
  } finally {
    cleanup();
  }
});

test('FileBackedMemoryProvider: scopes by target_key', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const provider = new FileBackedMemoryProvider();
    const stagingScope: MemoryScope = {
      specPath,
      specId: 'demo',
      target: { type: 'web', url: 'https://staging.example.com' },
    };
    const prodScope: MemoryScope = {
      specPath,
      specId: 'demo',
      target: { type: 'web', url: 'https://example.com' },
    };

    await provider.write(stagingScope, 'r1', [
      { type: 'observation', content: 'Staging has feature flag X enabled.' },
    ]);
    const prod = await provider.read(prodScope);
    assert.equal(prod.rows.length, 0, 'prod scope must not see staging rows');

    const staging = await provider.read(stagingScope);
    assert.equal(staging.rows.length, 1);
  } finally {
    cleanup();
  }
});

test('defaultMemoryProvider returns a FileBackedMemoryProvider', () => {
  const p = defaultMemoryProvider();
  assert.ok(p instanceof FileBackedMemoryProvider);
});

test('FileBackedMemoryProvider: prefetch returns empty on cold scope', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const provider = new FileBackedMemoryProvider();
    const scope: MemoryScope = {
      specPath,
      specId: 'cold',
      target: { type: 'cli', binary: '/tmp/nope' },
    };
    const out = await provider.prefetch(scope);
    assert.equal(out, '');
  } finally {
    cleanup();
  }
});
