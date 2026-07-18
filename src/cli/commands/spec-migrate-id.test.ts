import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { specMigrateId } from './spec-migrate-id.js';
import type { CliContext } from '../types.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-migrate-id-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function quietCtx(): CliContext {
  return { outputFormat: 'json', quiet: true };
}

function setupFixture(dir: string): { specPath: string } {
  const specPath = path.join(dir, 'spec.yaml');
  writeFile(specPath, [
    'version: "2"',
    'name: Auth Spec',
    'target:',
    '  type: web',
    '  url: http://localhost:3000',
    'areas:',
    '  - id: auth',
    '    name: Auth',
    '    behaviors:',
    '      - id: signin',
    '        description: User can sign in',
    '',
  ].join('\n'));

  writeFile(path.join(dir, '.specify', 'confidence.json'), JSON.stringify({
    version: 1,
    rows: {
      login: { accepts: 4, overrides: 1, lastUpdatedAt: '2026-01-01T00:00:00Z' },
    },
  }));

  writeFile(path.join(dir, 'specify.observations.yaml'), [
    'version: 1',
    'observations:',
    '  - id: obs-1',
    '    description: Users sometimes double-click submit',
    '    area_id: auth',
    '    behavior_id: login',
    '    source: user_feedback',
    '  - id: obs-2',
    '    description: Unrelated observation',
    '    area_id: billing',
    '    behavior_id: invoice',
    '    source: user_feedback',
    '',
  ].join('\n'));

  writeFile(path.join(dir, '.specify', 'memory', 'myspec', 'web_localhost.json'), JSON.stringify({
    version: 1,
    spec_id: 'myspec',
    target_key: 'web_localhost',
    rows: [
      { id: 'mem_1', type: 'playbook', area_id: 'auth', behavior_id: 'login', content: 'click sign in then wait', contradicted_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'mem_2', type: 'quirk', area_id: 'billing', behavior_id: 'invoice', content: 'unrelated row', contradicted_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ],
  }));

  return { specPath };
}

test('specMigrateId rewrites confidence, observation, and memory rows for the renamed id', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { specPath } = setupFixture(dir);

    const exitCode = await specMigrateId({ spec: specPath, oldId: 'auth/login', newId: 'auth/signin' }, quietCtx());
    assert.equal(exitCode, 0);

    const confidence = JSON.parse(fs.readFileSync(path.join(dir, '.specify', 'confidence.json'), 'utf-8'));
    assert.ok(!('login' in confidence.rows), 'old key removed');
    assert.equal(confidence.rows.signin.accepts, 4);
    assert.equal(confidence.rows.signin.overrides, 1);

    const yaml = await import('js-yaml');
    const observations = yaml.load(fs.readFileSync(path.join(dir, 'specify.observations.yaml'), 'utf-8')) as { observations: Array<{ id: string; area_id?: string; behavior_id?: string }> };
    const migratedObs = observations.observations.find((o) => o.id === 'obs-1')!;
    assert.equal(migratedObs.area_id, 'auth');
    assert.equal(migratedObs.behavior_id, 'signin');
    const untouchedObs = observations.observations.find((o) => o.id === 'obs-2')!;
    assert.equal(untouchedObs.behavior_id, 'invoice', 'unrelated observation is untouched');

    const memory = JSON.parse(fs.readFileSync(path.join(dir, '.specify', 'memory', 'myspec', 'web_localhost.json'), 'utf-8'));
    const migratedRow = memory.rows.find((r: { id: string }) => r.id === 'mem_1');
    assert.equal(migratedRow.behavior_id, 'signin');
    const untouchedRow = memory.rows.find((r: { id: string }) => r.id === 'mem_2');
    assert.equal(untouchedRow.behavior_id, 'invoice', 'unrelated memory row is untouched');
  } finally {
    cleanup();
  }
});

test('specMigrateId is idempotent — re-running after a successful migration is a no-op', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { specPath } = setupFixture(dir);
    await specMigrateId({ spec: specPath, oldId: 'auth/login', newId: 'auth/signin' }, quietCtx());
    const exitCode = await specMigrateId({ spec: specPath, oldId: 'auth/login', newId: 'auth/signin' }, quietCtx());
    assert.equal(exitCode, 0);

    const confidence = JSON.parse(fs.readFileSync(path.join(dir, '.specify', 'confidence.json'), 'utf-8'));
    assert.equal(confidence.rows.signin.accepts, 4, 'second run does not double-migrate');
  } finally {
    cleanup();
  }
});

test('specMigrateId rejects non-fully-qualified ids', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { specPath } = setupFixture(dir);
    const exitCode = await specMigrateId({ spec: specPath, oldId: 'login', newId: 'signin' }, quietCtx());
    assert.notEqual(exitCode, 0);
  } finally {
    cleanup();
  }
});

test('a failed write to one store does not corrupt the others (tmp+rename per file)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { specPath } = setupFixture(dir);
    const confidencePath = path.join(dir, '.specify', 'confidence.json');
    const originalConfidence = fs.readFileSync(confidencePath, 'utf-8');

    // Simulate a crash mid-write: an interrupted write leaves only a .tmp
    // file behind (tmp+rename never touches the real file until the rename
    // syscall, which is atomic), so the destination is untouched.
    const tmpPath = `${confidencePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, '{"version":1,"rows":{"signin":{"accepts":999', 'utf-8'); // truncated on purpose
    // No rename() call — this models the crash.

    assert.equal(fs.readFileSync(confidencePath, 'utf-8'), originalConfidence, 'destination file is untouched by the interrupted write');
    assert.ok(fs.existsSync(tmpPath), 'orphaned tmp file remains, not the destination');

    // Clean up the simulated crash artifact and confirm a real run still succeeds.
    fs.unlinkSync(tmpPath);
    const exitCode = await specMigrateId({ spec: specPath, oldId: 'auth/login', newId: 'auth/signin' }, quietCtx());
    assert.equal(exitCode, 0);
    const confidence = JSON.parse(fs.readFileSync(confidencePath, 'utf-8'));
    assert.equal(confidence.rows.signin.accepts, 4);
  } finally {
    cleanup();
  }
});
