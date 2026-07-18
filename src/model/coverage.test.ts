import assert from 'node:assert/strict';
import test from 'node:test';
import type { StepObservation } from '../agent/observation.js';
import { learn, type SessionTrace, type PredicateExtractor } from './nav-model.js';
import {
  computeCoverage,
  explorationHints,
  renderExplorationHints,
  renderCoverageSummary,
} from './coverage.js';

// ---------------------------------------------------------------------------
// Fixtures
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

/** A run that walks / -> /users -> /users/:id -> /settings. */
function fullWalk(ref: string): SessionTrace {
  return {
    ref,
    steps: [
      step({ step: 0, action: 'browser_goto', urlBefore: '', urlAfter: 'http://app/', args: { url: 'http://app/' } }),
      step({ step: 1, action: 'browser_click', urlBefore: 'http://app/', urlAfter: 'http://app/users', args: { selector: '#users-link' } }),
      step({ step: 2, action: 'browser_click', urlBefore: 'http://app/users', urlAfter: 'http://app/users/1', args: { selector: '.row' } }),
      step({ step: 3, action: 'browser_click', urlBefore: 'http://app/users/1', urlAfter: 'http://app/settings', args: { selector: '#settings' } }),
    ],
  };
}

/** A shorter run that only walks / -> /users. */
function shallowWalk(ref: string): SessionTrace {
  return {
    ref,
    steps: [
      step({ step: 0, action: 'browser_goto', urlBefore: '', urlAfter: 'http://app/', args: { url: 'http://app/' } }),
      step({ step: 1, action: 'browser_click', urlBefore: 'http://app/', urlAfter: 'http://app/users', args: { selector: '#users-link' } }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test('full-walk run covers 100% of a model learned from that same walk', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const cov = computeCoverage(model, [fullWalk('r1')]);
  assert.equal(cov.empty, false);
  assert.equal(cov.states.visited, cov.states.known);
  assert.equal(cov.states.ratio, 1);
  assert.equal(cov.transitions.visited, cov.transitions.known);
  assert.equal(cov.transitions.ratio, 1);
  assert.deepEqual(cov.states.unvisited, []);
  assert.deepEqual(cov.transitions.unvisited, []);
});

test('a shallow run leaves the deeper states and transitions uncovered', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const cov = computeCoverage(model, [shallowWalk('r2')]);
  // The model knows /, /users, /users/:id, /settings — the shallow run only
  // reached / and /users.
  assert.ok(cov.states.known >= 4);
  assert.equal(cov.states.visited, 2);
  assert.ok(cov.states.ratio > 0 && cov.states.ratio < 1);
  // Only the first edge (/ -> /users) is covered; the two deeper edges are not.
  assert.equal(cov.transitions.known, 3);
  assert.equal(cov.transitions.visited, 1);
  assert.equal(cov.transitions.unvisited.length, 2);
});

test('coverage is order-independent and idempotent by session ref', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const a = computeCoverage(model, [shallowWalk('r2')]);
  const b = computeCoverage(model, [shallowWalk('r2'), shallowWalk('r2')]);
  assert.deepEqual(a, b);
});

test('coverage over the union of runs is at least each individual run', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const shallow = computeCoverage(model, [shallowWalk('r2')]);
  const union = computeCoverage(model, [shallowWalk('r2'), fullWalk('r3')]);
  assert.ok(union.states.visited >= shallow.states.visited);
  assert.equal(union.states.ratio, 1);
});

test('empty model yields an empty report with zero ratios', () => {
  const model = learn('spec', 'target', []);
  const cov = computeCoverage(model, [fullWalk('r1')]);
  assert.equal(cov.empty, true);
  assert.equal(cov.states.known, 0);
  assert.equal(cov.states.ratio, 0);
  assert.equal(cov.transitions.ratio, 0);
});

test('predicate-extractor mismatch is flagged on the report', () => {
  const extractor: PredicateExtractor = () => ({ hasForm: true });
  const model = learn('spec', 'target', [fullWalk('r1')], { predicates: extractor });
  // Measure with the DEFAULT (no) extractor — a different abstraction.
  const cov = computeCoverage(model, [fullWalk('r1')]);
  assert.equal(cov.predicateMismatch, true);
  // Matching extractor clears the flag and restores full coverage.
  const ok = computeCoverage(model, [fullWalk('r1')], { predicates: extractor });
  assert.equal(ok.predicateMismatch, false);
  assert.equal(ok.states.ratio, 1);
});

test('renderCoverageSummary produces a readable one-liner', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const cov = computeCoverage(model, [shallowWalk('r2')]);
  const line = renderCoverageSummary(cov);
  assert.ok(line.includes('states'));
  assert.ok(line.includes('transitions'));
  assert.ok(line.includes('%'));
  assert.ok(renderCoverageSummary(computeCoverage(learn('s', 't', []), [])).includes('no model'));
});

// ---------------------------------------------------------------------------
// Exploration hints
// ---------------------------------------------------------------------------

test('an empty model emits no hints (first capture is never steered)', () => {
  const model = learn('spec', 'target', []);
  assert.deepEqual(explorationHints(model), []);
  assert.equal(renderExplorationHints(explorationHints(model)), '');
});

test('hints are deterministic for the same model and options', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const a = explorationHints(model, { limit: 5 });
  const b = explorationHints(model, { limit: 5 });
  assert.deepEqual(a, b);
});

test('a coverage report floats uncovered elements to the top of the hints', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const report = computeCoverage(model, [shallowWalk('r2')]);
  const hints = explorationHints(model, { report, limit: 10 });
  assert.ok(hints.length > 0);
  // At least one hint must be marked uncovered, and uncovered hints come first.
  assert.ok(hints.some((h) => h.uncovered));
  let sawCovered = false;
  for (const h of hints) {
    if (!h.uncovered) sawCovered = true;
    if (h.uncovered) assert.ok(!sawCovered, 'uncovered hints must precede covered ones');
  }
  // The uncovered /settings state should surface with a recipe to reach it.
  const settings = hints.find((h) => h.kind === 'state' && h.urlTemplate === '/settings');
  assert.ok(settings);
  assert.ok(settings!.uncovered);
  assert.ok(settings!.recipe, 'reachable state hint should carry an incoming recipe');
  assert.equal(settings!.recipe!.selector, '#settings');
});

test('limit caps the number of hints; zero/negative limits emit none', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  assert.equal(explorationHints(model, { limit: 2 }).length, 2);
  assert.deepEqual(explorationHints(model, { limit: 0 }), []);
  assert.deepEqual(explorationHints(model, { limit: -1 }), []);
});

test('rarely-visited elements rank ahead of frequently-visited ones without a report', () => {
  // Fold the shallow (/ -> /users) walk many times and the deep tail once, so
  // /users is high-count and /settings is low-count.
  const sessions: SessionTrace[] = [
    fullWalk('deep'),
    shallowWalk('s1'),
    shallowWalk('s2'),
    shallowWalk('s3'),
  ];
  const model = learn('spec', 'target', sessions);
  const hints = explorationHints(model, { limit: 3 });
  const templates = hints.filter((h) => h.kind === 'state').map((h) => h.urlTemplate);
  // /settings (seen once) should rank ahead of /users (seen 4x).
  const settingsIdx = templates.indexOf('/settings');
  const usersIdx = templates.indexOf('/users');
  assert.ok(settingsIdx !== -1);
  if (usersIdx !== -1) assert.ok(settingsIdx < usersIdx);
});

test('renderExplorationHints emits a scoped markdown block or empty string', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const rendered = renderExplorationHints(explorationHints(model, { limit: 3 }));
  assert.ok(rendered.includes('Coverage-directed exploration hints'));
  assert.ok(rendered.includes('breadth survey'));
  assert.ok(rendered.includes('- '));
  assert.equal(renderExplorationHints([]), '');
});

test('transition hints carry a recipe and both endpoints', () => {
  const model = learn('spec', 'target', [fullWalk('r1')]);
  const hints = explorationHints(model, { limit: 20 });
  const tr = hints.find((h) => h.kind === 'transition');
  assert.ok(tr);
  assert.ok(tr!.recipe);
  assert.ok(tr!.fromUrlTemplate);
  assert.ok(tr!.toUrlTemplate);
});
