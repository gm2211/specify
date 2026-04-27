import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendObservation,
  defaultObservationsPath,
  defaultProjectMemoryPath,
  defaultUserMemoryPath,
  loadLayeredContext,
  loadObservations,
  renderLayeredPrompt,
  saveObservations,
} from './memory-layers.js';

function tmpDir(): { dir: string; specPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-layers-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { dir, specPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('observations: round-trip save/load', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const filePath = path.join(dir, 'observations.yaml');
    saveObservations(filePath, {
      version: 1,
      observations: [
        { id: 'obs-1', description: 'Always check empty state on search.', area_id: 'forms' },
        { id: 'obs-2', description: 'Verify keyboard nav on form submit buttons.', confidence: 0.8, source: 'user_feedback' },
      ],
    });
    const loaded = loadObservations(filePath);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1].source, 'user_feedback');
    assert.equal(loaded[1].confidence, 0.8);
  } finally {
    cleanup();
  }
});

test('appendObservation: idempotent append + persist', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const filePath = path.join(dir, 'observations.yaml');
    appendObservation(filePath, { id: 'obs-1', description: 'first' });
    appendObservation(filePath, { id: 'obs-2', description: 'second' });
    const loaded = loadObservations(filePath);
    assert.deepEqual(loaded.map((o) => o.id), ['obs-1', 'obs-2']);
  } finally {
    cleanup();
  }
});

test('loadLayeredContext: picks SPECIFY.md over CLAUDE.md', () => {
  const { dir, specPath, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# claude content\n');
    fs.writeFileSync(path.join(dir, 'SPECIFY.md'), '# specify content\n');
    const ctx = loadLayeredContext(specPath, { userPath: '/nonexistent/user.md' });
    assert.match(ctx.project ?? '', /specify content/);
  } finally {
    cleanup();
  }
});

test('loadLayeredContext: falls back to CLAUDE.md when SPECIFY.md missing', () => {
  const { dir, specPath, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# claude content\n');
    const ctx = loadLayeredContext(specPath, { userPath: '/nonexistent/user.md' });
    assert.match(ctx.project ?? '', /claude content/);
  } finally {
    cleanup();
  }
});

test('renderLayeredPrompt: assembles all three sections', () => {
  const { dir, specPath, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'SPECIFY.md'), 'project: test the login flow under flaky network');
    const userPath = path.join(dir, 'user.md');
    fs.writeFileSync(userPath, 'user: prefers concise reports');
    appendObservation(defaultObservationsPath(specPath), {
      id: 'obs-1',
      description: 'Always probe empty states on search bars',
      area_id: 'forms',
      source: 'user_feedback',
      confidence: 0.7,
    });
    const ctx = loadLayeredContext(specPath, { userPath });
    const prompt = renderLayeredPrompt(ctx);
    assert.match(prompt, /User-level preferences/);
    assert.match(prompt, /Project context/);
    assert.match(prompt, /Derived observations/);
    assert.match(prompt, /empty states/);
    assert.match(prompt, /<user_feedback>/);
  } finally {
    cleanup();
  }
});

test('renderLayeredPrompt: returns empty when no layers present', () => {
  const { specPath, cleanup } = tmpDir();
  try {
    const ctx = loadLayeredContext(specPath, { userPath: '/nonexistent/user.md' });
    const prompt = renderLayeredPrompt(ctx);
    assert.equal(prompt, '');
  } finally {
    cleanup();
  }
});

test('renderLayeredPrompt: confidence floor filters low-confidence observations', () => {
  const { specPath, cleanup } = tmpDir();
  try {
    appendObservation(defaultObservationsPath(specPath), { id: 'high', description: 'high conf', confidence: 0.9 });
    appendObservation(defaultObservationsPath(specPath), { id: 'low', description: 'low conf', confidence: 0.2 });
    const ctx = loadLayeredContext(specPath, { userPath: '/nonexistent/user.md' });
    const prompt = renderLayeredPrompt(ctx, { observationConfidenceFloor: 0.5 });
    assert.match(prompt, /high conf/);
    assert.doesNotMatch(prompt, /low conf/);
  } finally {
    cleanup();
  }
});

test('renderLayeredPrompt: trims to budget by dropping trailing sections', () => {
  const { dir, specPath, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'SPECIFY.md'), 'p'.repeat(2000));
    fs.writeFileSync(path.join(dir, 'user.md'), 'u'.repeat(500));
    const ctx = loadLayeredContext(specPath, { userPath: path.join(dir, 'user.md') });
    const prompt = renderLayeredPrompt(ctx, { budgetBytes: 1000 });
    assert.ok(Buffer.byteLength(prompt, 'utf-8') <= 1000);
    assert.match(prompt, /User-level preferences/, 'user section should remain');
  } finally {
    cleanup();
  }
});

test('default paths resolve to expected locations', () => {
  const userPath = defaultUserMemoryPath();
  assert.match(userPath, /\.specify\/memory\.md$/);
  const obsPath = defaultObservationsPath('/tmp/proj/specify.spec.yaml');
  assert.equal(obsPath, '/tmp/proj/specify.observations.yaml');
  // No file exists yet so project resolves null
  assert.equal(defaultProjectMemoryPath('/tmp/nonexistent/specify.spec.yaml'), null);
});
