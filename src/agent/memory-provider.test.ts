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
import { FaultInjector } from './fault-injector.js';

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

test('mid-run fault activation routes memory writes to the +faults scope, not the healthy target', async () => {
  // Reproduces the write-time scoping used by sdk-runner: the scope's target
  // exposes faultsActive as a LIVE getter backed by the session's
  // FaultInjector. Faults injected mid-run (browser_inject_fault → addRule),
  // after the scope was constructed, must flip subsequent writes to the
  // '+faults' target key — synthetic-failure lessons must never land in the
  // healthy target's memory file (its quirks auto-reinject into future
  // healthy-run prompts).
  const { specPath, cleanup } = tmpSpec();
  try {
    const provider = new FileBackedMemoryProvider();
    const injector = new FaultInjector({ seed: 1, rules: [] });
    const scope: MemoryScope = {
      specPath,
      specId: 'demo',
      target: {
        type: 'web',
        url: 'https://app.example.com',
        get faultsActive(): boolean {
          return injector.hasEverActivated();
        },
      },
    };
    const healthyScope: MemoryScope = {
      specPath,
      specId: 'demo',
      target: { type: 'web', url: 'https://app.example.com' },
    };

    // Before any fault activation: writes land in the healthy scope.
    assert.equal(scopeTargetKey(scope), 'web_app.example.com');
    await provider.write(scope, 'r1', [
      { type: 'playbook', content: 'Healthy-run lesson.' },
    ]);
    const beforeActivation = await provider.read(healthyScope);
    assert.equal(beforeActivation.rows.length, 1);

    // Mid-run fault activation (what browser_inject_fault does).
    injector.addRule({ urlPattern: '/api/', fault: '500', rate: 1.0 });
    assert.equal(scopeTargetKey(scope), 'web_app.example.com+faults');
    await provider.write(scope, 'r1', [
      { type: 'quirk', content: 'Shows raw 500 JSON instead of a friendly error.', severity: 'major' },
    ]);

    // The healthy target's memory file must be untouched by the fault-run write.
    const healthy = await provider.read(healthyScope);
    assert.equal(healthy.rows.length, 1, 'fault-run write must not land in the healthy scope');
    assert.equal(healthy.rows[0].content, 'Healthy-run lesson.');

    // The fault-run lesson lives in the '+faults' scope.
    const faultScope: MemoryScope = {
      specPath,
      specId: 'demo',
      target: { type: 'web', url: 'https://app.example.com', faultsActive: true },
    };
    const faulted = await provider.read(faultScope);
    assert.equal(faulted.rows.length, 1);
    assert.match(faulted.rows[0].content, /friendly error/);

    // Clearing faults does NOT route writes back to the healthy scope —
    // the flag is sticky for the rest of the session.
    injector.clear();
    assert.equal(scopeTargetKey(scope), 'web_app.example.com+faults');
    await provider.write(scope, 'r1', [
      { type: 'observation', content: 'Recorded after clear().' },
    ]);
    const healthyAfterClear = await provider.read(healthyScope);
    const faultedAfterClear = await provider.read(faultScope);
    assert.equal(healthyAfterClear.rows.length, 1, 'post-clear writes must stay in the +faults scope');
    assert.equal(faultedAfterClear.rows.length, 2);
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
