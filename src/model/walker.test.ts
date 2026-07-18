import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NavModel, ModelState, ModelTransition, Recipe } from './nav-model.js';
import { arcKey } from './nav-model.js';
import {
  generateTraceSuite,
  traceRecipes,
  renderSuiteSummary,
  modelHashOf,
  suiteIsStale,
  pairKey,
  traceSuitePath,
  saveTraceSuite,
  loadTraceSuite,
  DEFAULT_BUDGET,
  type TraceSuite,
  type Trace,
} from './walker.js';

// ---------------------------------------------------------------------------
// Fixture builders — hand-built models for precise graph control.
// ---------------------------------------------------------------------------

function state(id: string, urlTemplate: string): ModelState {
  return { id, urlTemplate, predicates: {}, seenCount: 1, examples: [] };
}

function edge(from: string, action: string, selector: string, to: string[]): ModelTransition {
  const recipe: Recipe = { action, selector };
  const ak = shortActionKey(action, selector);
  return {
    from,
    actionKey: ak,
    recipe,
    targets: to.map((t) => ({ to: t, count: 1, lastSeen: 1, networkSignature: [] })),
  };
}

// Match nav-model's actionKey shape well enough for a stable, unique key; the
// walker treats actionKey opaquely, so any deterministic string works here.
function shortActionKey(action: string, selector: string): string {
  return `${action}:${selector}`;
}

function baseModel(): NavModel {
  // Graph:  A(/) --usersLink--> B(/users) --row--> C(/users/:id) --settings--> D(/settings)
  //         D --home--> A            (cycle back)
  //         A --settingsLink--> D    (a second path into D)
  return {
    version: 2,
    specId: 'spec',
    targetKey: 'target',
    abstractionConfig: { maxStates: 500, overflow: 'coarsen', minDistinctForParam: 8 },
    states: [
      state('A', '/'),
      state('B', '/users'),
      state('C', '/users/:id'),
      state('D', '/settings'),
    ],
    transitions: [
      edge('A', 'browser_click', '#users', ['B']),
      edge('B', 'browser_click', '.row', ['C']),
      edge('C', 'browser_click', '#settings', ['D']),
      edge('D', 'browser_click', '#home', ['A']),
      edge('A', 'browser_click', '#settings', ['D']),
    ],
    sessions: ['s1'],
    templates: { sourceUrls: [], params: [] } as unknown as NavModel['templates'],
    predicateKeys: [],
    orphanedStatesPruned: 0,
    truncated: false,
    coarsened: false,
  };
}

/** A model with a nondeterministic edge: A --go--> {B, C}. */
function nondeterministicModel(): NavModel {
  const m = baseModel();
  m.transitions = [
    edge('A', 'browser_click', '#go', ['B', 'C']),
    edge('B', 'browser_click', '.row', ['C']),
    edge('C', 'browser_click', '#settings', ['D']),
  ];
  return m;
}

function emptyModel(): NavModel {
  const m = baseModel();
  m.states = [];
  m.transitions = [];
  return m;
}

/** Two disconnected components: no single contiguous walk can span both. */
function disconnectedModel(): NavModel {
  const m = baseModel();
  m.states = [state('A', '/a'), state('B', '/b'), state('C', '/c'), state('D', '/d')];
  m.transitions = [
    edge('A', 'browser_click', '#x', ['B']),
    edge('C', 'browser_click', '#y', ['D']),
  ];
  return m;
}

// ---------------------------------------------------------------------------
// Suite invariants — a reusable structural check applied across tests.
// ---------------------------------------------------------------------------

function knownArcKeys(model: NavModel): Set<string> {
  const s = new Set<string>();
  for (const tr of model.transitions) {
    for (const t of tr.targets) s.add(arcKey(tr.from, tr.actionKey, t.to));
  }
  return s;
}

/** Every walk must be a real, contiguous path through the model's arcs. */
function assertWellFormed(suite: TraceSuite, model: NavModel): void {
  const knownArcs = knownArcKeys(model);
  const urlOf = new Map(model.states.map((s) => [s.id, s.urlTemplate]));
  for (const trace of suite.traces) {
    assert.equal(trace.startUrlTemplate, urlOf.get(trace.startState) ?? trace.startState);
    let cursor = trace.startState;
    for (const tr of trace.transitions) {
      assert.ok(knownArcs.has(tr.arc), `arc ${tr.arc} must exist in the model`);
      assert.equal(tr.from, cursor, 'each transition starts where the previous one landed');
      assert.equal(tr.arc, arcKey(tr.from, tr.actionKey, tr.to));
      cursor = tr.to;
    }
    assert.ok(
      trace.transitions.length <= suite.budget.maxWalkLength,
      'walk length must respect the budget',
    );
  }
}

// ---------------------------------------------------------------------------
// Coverage — the acceptance criterion.
// ---------------------------------------------------------------------------

test('all-transitions achieves 100% transition coverage on a fixture model', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 1, criteria: ['all-transitions'] });
  assert.equal(suite.coverage.transitions.ratio, 1);
  assert.equal(suite.coverage.transitions.covered, suite.coverage.transitions.known);
  assert.deepEqual(suite.coverage.transitions.uncovered, []);
  assert.equal(suite.truncated, false);
  assertWellFormed(suite, model);
});

test('all-states achieves 100% state coverage', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 1, criteria: ['all-states'] });
  assert.equal(suite.coverage.states.ratio, 1);
  assert.deepEqual(suite.coverage.states.uncovered, []);
  assert.equal(suite.truncated, false);
  assertWellFormed(suite, model);
});

test('all-transition-pairs covers every feasible consecutive-arc pair', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 3, criteria: ['all-transition-pairs'] });
  assert.ok(suite.coverage.pairs, 'pairs axis present when pairs requested');
  assert.equal(suite.coverage.pairs!.ratio, 1);
  assert.deepEqual(suite.coverage.pairs!.uncovered, []);
  // Pairs subsume transitions and states.
  assert.equal(suite.coverage.transitions.ratio, 1);
  assert.equal(suite.coverage.states.ratio, 1);
  assert.equal(suite.truncated, false);
  assertWellFormed(suite, model);
});

test('every covered pair is actually taken back-to-back by some walk', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 5, criteria: ['all-transition-pairs'] });
  const takenPairs = new Set<string>();
  for (const trace of suite.traces) {
    for (let i = 1; i < trace.transitions.length; i++) {
      takenPairs.add(pairKey(trace.transitions[i - 1].arc, trace.transitions[i].arc));
    }
  }
  // The report's covered count equals the number of distinct pairs actually walked.
  assert.equal(suite.coverage.pairs!.covered, takenPairs.size);
});

test('nondeterministic edge — each target is its own arc obligation, all covered', () => {
  const model = nondeterministicModel();
  const suite = generateTraceSuite(model, { seed: 2, criteria: ['all-transitions'] });
  // A --go--> B and A --go--> C are two distinct arcs.
  assert.equal(suite.coverage.transitions.known, 4);
  assert.equal(suite.coverage.transitions.ratio, 1);
  assertWellFormed(suite, model);
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test('same seed produces a byte-identical suite', () => {
  const model = baseModel();
  const a = generateTraceSuite(model, { seed: 42, criteria: ['all-transition-pairs'] });
  const b = generateTraceSuite(model, { seed: 42, criteria: ['all-transition-pairs'] });
  assert.deepEqual(a, b);
});

test('every seed still reaches full transition coverage', () => {
  const model = baseModel();
  for (let seed = 0; seed < 8; seed++) {
    const suite = generateTraceSuite(model, { seed, criteria: ['all-transitions'] });
    assert.equal(suite.coverage.transitions.ratio, 1, `seed ${seed} must fully cover transitions`);
    assertWellFormed(suite, model);
  }
});

test('different seeds may yield different suites but equal coverage', () => {
  const model = baseModel();
  const s1 = generateTraceSuite(model, { seed: 1, criteria: ['all-transition-pairs'] });
  const s2 = generateTraceSuite(model, { seed: 99, criteria: ['all-transition-pairs'] });
  assert.equal(s1.coverage.pairs!.ratio, 1);
  assert.equal(s2.coverage.pairs!.ratio, 1);
});

// ---------------------------------------------------------------------------
// Bounds / budget.
// ---------------------------------------------------------------------------

test('no walk exceeds maxWalkLength', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, {
    seed: 1,
    criteria: ['all-transition-pairs'],
    maxWalkLength: 4,
  });
  for (const trace of suite.traces) {
    assert.ok(trace.transitions.length <= 4);
  }
});

test('a too-small maxWalks budget marks the suite truncated', () => {
  // Two disconnected components need two walks; capping at one leaves the
  // second component's arc uncovered.
  const model = disconnectedModel();
  const suite = generateTraceSuite(model, {
    seed: 1,
    criteria: ['all-transitions'],
    maxWalks: 1,
  });
  assert.equal(suite.traces.length, 1);
  assert.equal(suite.truncated, true);
  assert.ok(suite.coverage.transitions.ratio < 1);
});

test('pairs under a length-1 bound are infeasible → truncated, pairs uncovered', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, {
    seed: 1,
    criteria: ['all-transition-pairs'],
    maxWalkLength: 1,
  });
  assert.equal(suite.truncated, true);
  assert.equal(suite.coverage.pairs!.covered, 0);
  // Individual arcs still fit under a length-1 bound.
  assert.equal(suite.coverage.transitions.ratio, 1);
});

test('default budget is applied when unspecified', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model);
  assert.deepEqual(suite.budget, DEFAULT_BUDGET);
  assert.deepEqual(suite.criteria, ['all-states', 'all-transitions']);
  assert.equal(suite.seed, 1);
});

// ---------------------------------------------------------------------------
// Obligation honesty — bogus/infeasible obligations must be reported, never
// silently dropped, and key-collision hazards must fail loudly.
// ---------------------------------------------------------------------------

test('pairKey rejects arc keys containing the pair delimiter', () => {
  assert.throws(() => pairKey('a>>b', 'c'), /pair delimiter/);
  assert.throws(() => pairKey('a', 'c>>d'), /pair delimiter/);
  // Clean keys pass.
  assert.equal(pairKey('a', 'b'), 'a>>b');
});

test('a model whose keys would collide pair keys fails loudly, not silently', () => {
  // A hand-built (bogus) model with the pair delimiter inside an actionKey.
  // Real nav-model keys are hex hashes and can never contain it; the generator
  // must surface the hazard as an error rather than emit a suite whose pair
  // coverage counts silently conflate distinct obligations.
  const m = baseModel();
  m.transitions = [
    edge('A', 'browser_click', 'div >> #users', ['B']),
    edge('B', 'browser_click', '.row', ['C']),
  ];
  assert.throws(
    () => generateTraceSuite(m, { seed: 1, criteria: ['all-transition-pairs'] }),
    /pair delimiter/,
  );
});

test('infeasible obligations are reported as truncated + uncovered, not dropped', () => {
  // Under a zero-length walk bound every arc obligation is infeasible. The
  // honest outcome: the suite is truncated and every arc appears in the
  // uncovered list — never a clean 100% report with obligations quietly gone.
  const model = baseModel();
  const suite = generateTraceSuite(model, {
    seed: 1,
    criteria: ['all-transitions'],
    maxWalkLength: 0,
  });
  assert.equal(suite.truncated, true);
  assert.equal(suite.coverage.transitions.covered, 0);
  assert.equal(suite.coverage.transitions.uncovered.length, suite.coverage.transitions.known);
});

// ---------------------------------------------------------------------------
// Empty model.
// ---------------------------------------------------------------------------

test('empty model yields an empty, non-truncated suite with trivial coverage', () => {
  const model = emptyModel();
  const suite = generateTraceSuite(model, { criteria: ['all-transition-pairs'] });
  assert.deepEqual(suite.traces, []);
  assert.equal(suite.truncated, false);
  assert.equal(suite.coverage.states.ratio, 1);
  assert.equal(suite.coverage.transitions.ratio, 1);
  assert.equal(suite.coverage.pairs!.ratio, 1);
});

// ---------------------------------------------------------------------------
// Provenance.
// ---------------------------------------------------------------------------

test('suite records model provenance (version, hash, seed, criteria)', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 7, criteria: ['all-transitions'] });
  assert.equal(suite.modelVersion, 2);
  assert.equal(suite.seed, 7);
  assert.deepEqual(suite.criteria, ['all-transitions']);
  assert.equal(suite.modelHash, modelHashOf(model));
});

test('modelHashOf is stable and change-sensitive', () => {
  const model = baseModel();
  const h1 = modelHashOf(model);
  assert.equal(h1, modelHashOf(baseModel()));
  const drifted = baseModel();
  drifted.transitions.pop();
  assert.notEqual(h1, modelHashOf(drifted));
});

test('suiteIsStale detects a model that drifted out from under the suite', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 1 });
  assert.equal(suiteIsStale(suite, model), false);
  const drifted = baseModel();
  drifted.states.push(state('E', '/extra'));
  drifted.transitions.push(edge('D', 'browser_click', '#extra', ['E']));
  assert.equal(suiteIsStale(suite, drifted), true);
});

// ---------------------------------------------------------------------------
// Substrate accessors + rendering.
// ---------------------------------------------------------------------------

test('traceRecipes returns the ordered recipe substrate for a walk', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 1, criteria: ['all-transitions'] });
  const trace = suite.traces.find((t: Trace) => t.transitions.length > 0)!;
  const recipes = traceRecipes(trace);
  assert.equal(recipes.length, trace.transitions.length);
  for (let i = 0; i < recipes.length; i++) {
    assert.equal(recipes[i], trace.transitions[i].recipe);
    assert.equal(typeof recipes[i].action, 'string');
  }
});

test('renderSuiteSummary is a readable one-liner', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 1, criteria: ['all-transition-pairs'] });
  const line = renderSuiteSummary(suite);
  assert.match(line, /Trace suite: \d+ walks?,/);
  assert.match(line, /transitions \d+\/\d+ \(100%\)/);
  assert.match(line, /pairs \d+\/\d+/);
});

test('renderSuiteSummary flags truncation', () => {
  const model = disconnectedModel();
  const suite = generateTraceSuite(model, {
    criteria: ['all-transitions'],
    maxWalks: 1,
  });
  assert.match(renderSuiteSummary(suite), /truncated/);
});

// ---------------------------------------------------------------------------
// Store round-trip.
// ---------------------------------------------------------------------------

test('save/load round-trips a suite and path mirrors the model store layout', () => {
  const model = baseModel();
  const suite = generateTraceSuite(model, { seed: 1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-'));
  try {
    const p = traceSuitePath(dir, 'spec', 'target');
    assert.equal(p, path.join(dir, '.specify', 'traces', 'spec', 'target.json'));
    saveTraceSuite(p, suite);
    const loaded = loadTraceSuite(p);
    assert.deepEqual(loaded, suite);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTraceSuite returns null for a missing or corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-'));
  try {
    const p = path.join(dir, 'nope.json');
    assert.equal(loadTraceSuite(p), null);
    fs.writeFileSync(p, '{ not valid json', 'utf-8');
    assert.equal(loadTraceSuite(p), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
