import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCorpus,
  defaultPromptsDir,
  evolvePrompt,
  heuristicEvolve,
  listPromptVersions,
} from './prompt-evolution.js';
import { appendObservation, defaultObservationsPath } from './memory-layers.js';
import { ConfidenceStore, defaultConfidencePath } from './confidence-store.js';

function tmpSpec(): { specPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-evo-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { specPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('heuristicEvolve: prepends lessons learned + override hints', () => {
  const out = heuristicEvolve('base prompt', {
    observations: [
      { id: 'o1', description: 'always probe empty state', confidence: 0.9 },
      { id: 'o2', description: 'low conf skip', confidence: 0.3 },
    ],
    confidence: [
      { behaviorId: 'login', accepts: 1, overrides: 4, lastUpdatedAt: '' },
    ],
    recentSessions: [],
  });
  assert.match(out, /Lessons learned/);
  assert.match(out, /always probe empty state/);
  assert.doesNotMatch(out, /low conf skip/);
  assert.match(out, /Behaviors that have been overridden/);
  assert.match(out, /login/);
  assert.match(out, /base prompt$/);
});

test('heuristicEvolve: returns base prompt when corpus is empty', () => {
  const out = heuristicEvolve('base prompt', { observations: [], confidence: [], recentSessions: [] });
  assert.equal(out, 'base prompt');
});

test('evolvePrompt: writes versioned prompt file', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    appendObservation(defaultObservationsPath(specPath), { id: 'o1', description: 'test obs', confidence: 0.9 });
    const r = await evolvePrompt('base', { specPath, heuristicOnly: true });
    assert.equal(r.source, 'heuristic');
    assert.match(r.prompt, /test obs/);
    assert.ok(fs.existsSync(r.promptPath));
    assert.equal(path.dirname(r.promptPath), defaultPromptsDir(specPath));
  } finally {
    cleanup();
  }
});

test('listPromptVersions: returns chronological order', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const r1 = await evolvePrompt('a', { specPath, heuristicOnly: true });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await evolvePrompt('b', { specPath, heuristicOnly: true });
    const versions = listPromptVersions(specPath);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].filePath, r1.promptPath);
    assert.equal(versions[1].filePath, r2.promptPath);
  } finally {
    cleanup();
  }
});

test('buildCorpus: assembles observations + confidence', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    appendObservation(defaultObservationsPath(specPath), { id: 'o1', description: 'check empty state', confidence: 0.8 });
    new ConfidenceStore(defaultConfidencePath(specPath)).record('login', 'override');
    const corpus = await buildCorpus(specPath);
    assert.equal(corpus.observations.length, 1);
    assert.equal(corpus.confidence.length, 1);
    assert.equal(corpus.confidence[0].behaviorId, 'login');
  } finally {
    cleanup();
  }
});
