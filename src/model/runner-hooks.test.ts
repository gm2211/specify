import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StepObservation } from '../agent/observation.js';
import { loadModel, modelPath } from './nav-model.js';
import {
  foldRunAndSummarizeCoverage,
  loadExplorationHints,
  loadExplorationHintsForSpecFile,
} from './runner-hooks.js';

// ---------------------------------------------------------------------------
// Fixtures — mirror src/model/coverage.test.ts's step/walk shapes.
// ---------------------------------------------------------------------------

function step(
  partial: Partial<StepObservation> & { action: string; urlBefore: string; urlAfter: string },
): StepObservation {
  const idx = partial.step ?? 0;
  const tsStart = 1000 + idx * 10;
  return {
    step: idx,
    action: partial.action,
    args: partial.args,
    success: partial.success ?? true,
    urlBefore: partial.urlBefore,
    urlAfter: partial.urlAfter,
    title: partial.title,
    tsStart: partial.tsStart ?? tsStart,
    tsEnd: partial.tsEnd ?? tsStart + 5,
    ax: partial.ax ?? { unchanged: true, digest: 'd0' },
    trafficRange: partial.trafficRange ?? [0, 0],
    consoleRange: partial.consoleRange ?? [0, 0],
  };
}

/** A run that walks / -> /users -> /users/1 -> /settings. */
function fullWalk(): StepObservation[] {
  return [
    step({
      step: 0,
      action: 'browser_goto',
      urlBefore: '',
      urlAfter: 'http://app/',
      args: { url: 'http://app/' },
    }),
    step({
      step: 1,
      action: 'browser_click',
      urlBefore: 'http://app/',
      urlAfter: 'http://app/users',
      args: { selector: '#users-link' },
    }),
    step({
      step: 2,
      action: 'browser_click',
      urlBefore: 'http://app/users',
      urlAfter: 'http://app/users/1',
      args: { selector: '.row' },
    }),
    step({
      step: 3,
      action: 'browser_click',
      urlBefore: 'http://app/users/1',
      urlAfter: 'http://app/settings',
      args: { selector: '#settings' },
    }),
  ];
}

/** A shorter run that only walks / -> /users. */
function shallowWalk(): StepObservation[] {
  return [
    step({
      step: 0,
      action: 'browser_goto',
      urlBefore: '',
      urlAfter: 'http://app/',
      args: { url: 'http://app/' },
    }),
    step({
      step: 1,
      action: 'browser_click',
      urlBefore: 'http://app/',
      urlAfter: 'http://app/users',
      args: { selector: '#users-link' },
    }),
  ];
}

function tmpSpecRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navhooks-'));
  // The store keys on <specRootDir>/.specify/model/... — a fake spec file at the
  // root is enough for specRootDir() to resolve, but foldRun only needs the path.
  return dir;
}

const WEB_TARGET = { type: 'web' as const, url: 'http://app/' };

// ---------------------------------------------------------------------------
// Coverage embedding — fold-then-measure ordering
// ---------------------------------------------------------------------------

test('first run has no prior model: coverage is empty, but the run is folded in', () => {
  const root = tmpSpecRoot();
  const specPath = path.join(root, 'spec.yaml');

  const cov = foldRunAndSummarizeCoverage({
    specPath,
    specId: 'demo',
    target: WEB_TARGET,
    ref: 'run-1',
    steps: fullWalk(),
    traffic: [],
  });

  // No map existed before this run, so there is nothing to have covered.
  assert.equal(cov.empty, true);
  assert.equal(cov.states.known, 0);
  assert.equal(cov.transitions.known, 0);
  assert.ok(cov.summary.includes('no model'));

  // The run WAS persisted for next time.
  const model = loadModel(modelPath(root, 'demo', 'web_app'));
  assert.ok(model);
  assert.ok(model!.states.length >= 4);
  assert.deepEqual(model!.sessions, ['run-1']);
});

test('second run is measured against the map the first run learned, then folded', () => {
  const root = tmpSpecRoot();
  const specPath = path.join(root, 'spec.yaml');

  // Run 1 seeds the map with the full walk.
  foldRunAndSummarizeCoverage({
    specPath,
    specId: 'demo',
    target: WEB_TARGET,
    ref: 'run-1',
    steps: fullWalk(),
    traffic: [],
  });

  // Run 2 only re-walks the shallow prefix — it should read as partial coverage
  // of the map learned in run 1 (NOT trivially 100% from folding itself first).
  const cov = foldRunAndSummarizeCoverage({
    specPath,
    specId: 'demo',
    target: WEB_TARGET,
    ref: 'run-2',
    steps: shallowWalk(),
    traffic: [],
  });

  assert.equal(cov.empty, false);
  assert.ok(cov.states.known >= 4);
  assert.equal(cov.states.visited, 2);
  assert.ok(cov.states.ratio > 0 && cov.states.ratio < 1);
  assert.equal(cov.predicateMismatch, false);

  // Both runs are now folded in.
  const model = loadModel(modelPath(root, 'demo', 'web_app'));
  assert.deepEqual(model!.sessions, ['run-1', 'run-2']);
});

test('re-folding the same run ref is idempotent', () => {
  const root = tmpSpecRoot();
  const specPath = path.join(root, 'spec.yaml');
  const args = {
    specPath,
    specId: 'demo',
    target: WEB_TARGET,
    ref: 'run-1',
    steps: fullWalk(),
    traffic: [],
  };
  foldRunAndSummarizeCoverage(args);
  foldRunAndSummarizeCoverage(args);
  const model = loadModel(modelPath(root, 'demo', 'web_app'));
  assert.deepEqual(model!.sessions, ['run-1']);
});

// ---------------------------------------------------------------------------
// Exploration hints — flag gating and first-capture behavior
// ---------------------------------------------------------------------------

test('hints are empty when the flag is off, even with a persisted model', () => {
  const root = tmpSpecRoot();
  const specPath = path.join(root, 'spec.yaml');
  foldRunAndSummarizeCoverage({
    specPath,
    specId: 'demo',
    target: WEB_TARGET,
    ref: 'run-1',
    steps: fullWalk(),
    traffic: [],
  });

  delete process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE;
  assert.equal(loadExplorationHints({ specPath, specId: 'demo', target: WEB_TARGET }), '');
});

test('hints render from a persisted model when the flag is on', () => {
  const root = tmpSpecRoot();
  const specPath = path.join(root, 'spec.yaml');
  foldRunAndSummarizeCoverage({
    specPath,
    specId: 'demo',
    target: WEB_TARGET,
    ref: 'run-1',
    steps: fullWalk(),
    traffic: [],
  });

  process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE = '1';
  try {
    const hints = loadExplorationHints({ specPath, specId: 'demo', target: WEB_TARGET });
    assert.ok(hints.includes('Coverage-directed exploration hints'));
  } finally {
    delete process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE;
  }
});

test('hints are empty for a target with no model yet (first capture is never steered)', () => {
  const root = tmpSpecRoot();
  const specPath = path.join(root, 'spec.yaml');
  process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE = '1';
  try {
    assert.equal(loadExplorationHints({ specPath, specId: 'brand-new', target: WEB_TARGET }), '');
  } finally {
    delete process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE;
  }
});

test('capture spec-file hints: empty when the spec file is absent (first-ever capture)', async () => {
  const root = tmpSpecRoot();
  process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE = '1';
  try {
    const hints = await loadExplorationHintsForSpecFile(path.join(root, 'does-not-exist.yaml'));
    assert.equal(hints, '');
  } finally {
    delete process.env.SPECIFY_ENABLE_NAV_MAP_COVERAGE;
  }
});
