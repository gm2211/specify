import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  NavModel,
  ModelState,
  ModelTransition,
  TransitionTarget,
  Recipe,
} from './nav-model.js';
import {
  diffModels,
  detectRegressions,
  detectRegressionAlarms,
  confirmRegression,
  edgeObservationCount,
  recurringTargets,
  isNondeterministic,
  isStableEdge,
  edgeStability,
  toAlarmRecord,
  triageAlarms,
  DEFAULT_STABILITY_CONFIG,
  type CandidateRegression,
  type ReplayObservation,
  type ReplayRequest,
  type TransitionReplayer,
} from './model-diff.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function state(id: string, urlTemplate: string): ModelState {
  return { id, urlTemplate, predicates: {}, seenCount: 1, examples: [] };
}

function target(
  to: string,
  count: number,
  extra: Partial<TransitionTarget> = {},
): TransitionTarget {
  return { to, count, lastSeen: 1000, networkSignature: [], ...extra };
}

function edge(
  from: string,
  action: string,
  targets: TransitionTarget[],
  recipe?: Recipe,
): ModelTransition {
  return {
    from,
    // A synthetic, stable action key derived from from+action so lookups match
    // across models the same way real actionKey hashes would.
    actionKey: `${from}:${action}`,
    recipe: recipe ?? { action, selector: `#${action}` },
    targets,
  };
}

function model(parts: {
  states: ModelState[];
  transitions: ModelTransition[];
  sessions: string[];
}): NavModel {
  return {
    version: 2,
    specId: 'spec',
    targetKey: 'target',
    abstractionConfig: { maxStates: 500, overflow: 'coarsen', minDistinctForParam: 8 },
    states: parts.states,
    transitions: parts.transitions,
    sessions: parts.sessions,
    templates: { sourceUrls: [], params: [] } as unknown as NavModel['templates'],
    predicateKeys: [],
    orphanedStatesPruned: 0,
    truncated: false,
    coarsened: false,
  };
}

/** Sessions ref list of length n. */
function sessions(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `s${i}`);
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

test('diffModels reports added/removed/common states', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [],
    sessions: sessions(1),
  });
  const cand = model({
    states: [state('a', '/'), state('c', '/c')],
    transitions: [],
    sessions: sessions(1),
  });
  const d = diffModels(base, cand);
  assert.deepEqual(d.states.added, ['c']);
  assert.deepEqual(d.states.removed, ['b']);
  assert.deepEqual(d.states.common, ['a']);
});

test('diffModels reports removed and added edges by (from, actionKey)', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 5)])],
    sessions: sessions(5),
  });
  const cand = model({
    states: [state('a', '/'), state('c', '/c')],
    transitions: [edge('a', 'goto', [target('c', 5)])],
    sessions: sessions(5),
  });
  const d = diffModels(base, cand);
  assert.equal(d.transitions.removed.length, 1);
  assert.equal(d.transitions.removed[0].actionKey, 'a:click');
  assert.equal(d.transitions.added.length, 1);
  assert.equal(d.transitions.added[0].actionKey, 'a:goto');
});

test('diffModels detects same-key different-target changes', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 5)])],
    sessions: sessions(5),
  });
  const cand = model({
    states: [state('a', '/'), state('c', '/c')],
    transitions: [edge('a', 'click', [target('c', 5)])],
    sessions: sessions(5),
  });
  const d = diffModels(base, cand);
  assert.equal(d.transitions.targetChanged.length, 1);
  assert.deepEqual(d.transitions.targetChanged[0].removedTargets, ['b']);
  assert.deepEqual(d.transitions.targetChanged[0].addedTargets, ['c']);
});

// ---------------------------------------------------------------------------
// Stability + nondeterminism
// ---------------------------------------------------------------------------

test('edgeObservationCount sums target counts', () => {
  assert.equal(edgeObservationCount(edge('a', 'x', [target('b', 3), target('c', 2)])), 5);
});

test('isStableEdge requires min observations and session fraction', () => {
  const e = edge('a', 'x', [target('b', 5)]);
  assert.equal(isStableEdge(e, 5), true); // 5 obs / 5 sessions = 1.0 >= 0.6
  assert.equal(isStableEdge(edge('a', 'x', [target('b', 2)]), 5), false); // below minObservations
  assert.equal(isStableEdge(e, 100), false); // 5/100 = 0.05 < 0.6
});

test('recurringTargets drops below-floor noise but keeps a primary', () => {
  const e = edge('a', 'x', [target('b', 9), target('c', 1)]); // c is 10% < 20% floor
  const rec = recurringTargets(e);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].to, 'b');
});

test('isNondeterministic true when two targets clear the floor', () => {
  assert.equal(isNondeterministic(edge('a', 'x', [target('b', 5), target('c', 5)])), true);
  assert.equal(isNondeterministic(edge('a', 'x', [target('b', 9), target('c', 1)])), false);
});

test('edgeStability reports metrics', () => {
  const s = edgeStability(edge('a', 'x', [target('b', 6)]), 6);
  assert.equal(s.observations, 6);
  assert.equal(s.sessionFraction, 1);
  assert.equal(s.stable, true);
  assert.equal(s.nondeterministic, false);
});

// ---------------------------------------------------------------------------
// Regression policy (pre-confirmation)
// ---------------------------------------------------------------------------

test('a stable edge that disappears is a candidate regression', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  // Candidate visited the from-state (a) but the edge is gone.
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  const regs = detectRegressions(base, cand);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].kind, 'edge_disappeared');
});

test('un-exercised from-state is NOT a regression (visit guard)', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  // Candidate never visited state 'a' at all.
  const cand = model({
    states: [state('z', '/z')],
    transitions: [],
    sessions: sessions(1),
  });
  assert.equal(detectRegressions(base, cand).length, 0);
});

test('an unstable edge disappearing raises no regression', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 1)])], // 1 obs — unstable
    sessions: sessions(8),
  });
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  assert.equal(detectRegressions(base, cand).length, 0);
});

test('deterministic edge whose target changed is a candidate regression', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  const cand = model({
    states: [state('a', '/'), state('c', '/c')],
    transitions: [edge('a', 'click', [target('c', 1)])],
    sessions: sessions(1),
  });
  const regs = detectRegressions(base, cand);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].kind, 'edge_target_changed');
});

test('nondeterministic edge is exempt from target-change alarms', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b'), state('c', '/c')],
    transitions: [edge('a', 'click', [target('b', 5), target('c', 5)])],
    sessions: sessions(10),
  });
  // Candidate only reached one of the two legitimate variants.
  const cand = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 1)])],
    sessions: sessions(1),
  });
  assert.equal(detectRegressions(base, cand).length, 0);
});

test('nondeterministic edge fully gone still raises a disappearance regression', () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b'), state('c', '/c')],
    transitions: [edge('a', 'click', [target('b', 5), target('c', 5)])],
    sessions: sessions(10),
  });
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  const regs = detectRegressions(base, cand);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].kind, 'edge_disappeared');
});

// ---------------------------------------------------------------------------
// Live confirmation (replay)
// ---------------------------------------------------------------------------

function fakeRegression(): CandidateRegression {
  return {
    kind: 'edge_disappeared',
    edge: { from: 'a', actionKey: 'a:click', recipe: { action: 'click', selector: '#click' } },
    fromState: state('a', '/'),
    stability: edgeStability(edge('a', 'click', [target('b', 8)]), 8),
    baselineRecurringTargets: [target('b', 8)],
    baselineTargets: [target('b', 8)],
    candidateTargets: [],
  };
}

test('confirmRegression: replay still reaches expected target ⇒ NOT confirmed', () => {
  const reg = fakeRegression();
  const obs: ReplayObservation = { reached: true, toState: 'b' };
  const c = confirmRegression(reg, obs);
  assert.equal(c.confirmed, false);
});

test('confirmRegression: replay reaches nothing ⇒ confirmed disappeared', () => {
  const reg = fakeRegression();
  const obs: ReplayObservation = { reached: false };
  const c = confirmRegression(reg, obs);
  assert.equal(c.confirmed, true);
  assert.equal(c.kind, 'edge_disappeared');
});

test('confirmRegression: replay reaches a different state ⇒ confirmed changed', () => {
  const reg = fakeRegression();
  const obs: ReplayObservation = { reached: true, toState: 'x' };
  const c = confirmRegression(reg, obs);
  assert.equal(c.confirmed, true);
  assert.equal(c.kind, 'edge_target_changed');
});

test('confirmRegression matches expected target by URL template', () => {
  const reg = fakeRegression();
  const obs: ReplayObservation = { reached: true, toUrlTemplate: '/b' };
  const c = confirmRegression(reg, obs, new Set(['/b']));
  assert.equal(c.confirmed, false);
});

test('confirmRegression: replay error ⇒ confirmed disappeared', () => {
  const reg = fakeRegression();
  const obs: ReplayObservation = { reached: false, error: 'selector not found' };
  const c = confirmRegression(reg, obs);
  assert.equal(c.confirmed, true);
  assert.equal(c.kind, 'edge_disappeared');
  assert.match(c.reason, /selector not found/);
});

// ---------------------------------------------------------------------------
// End-to-end alarms
// ---------------------------------------------------------------------------

/** A replayer that maps requested edges to canned observations. */
function replayerFrom(map: Record<string, ReplayObservation>): TransitionReplayer {
  return {
    async replay(req: ReplayRequest): Promise<ReplayObservation> {
      const key = `${req.edge.from}|${req.edge.actionKey}`;
      return map[key] ?? { reached: false };
    },
  };
}

test('acceptance: stable edge disappears + replay confirms ⇒ exactly one alarm with evidence', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [
      edge('a', 'click', [
        target('b', 8, {
          networkSignature: [{ method: 'GET', urlTemplate: '/api/b', statusClass: '2xx' }],
        }),
      ]),
    ],
    sessions: sessions(8),
  });
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  const replayer = replayerFrom({ 'a|a:click': { reached: false } });
  const alarms = await detectRegressionAlarms(base, cand, { replayer });
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].kind, 'edge_disappeared');
  assert.equal(alarms[0].confirmation?.confirmed, true);
  // Evidence carries the before recipe + network signature.
  assert.equal(alarms[0].evidence.before.recipe.action, 'click');
  assert.deepEqual(alarms[0].evidence.before.targets[0].networkSignature, [
    { method: 'GET', urlTemplate: '/api/b', statusClass: '2xx' },
  ]);
});

test('acceptance: noisy nondeterministic edge ⇒ zero alarms', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b'), state('c', '/c')],
    transitions: [edge('a', 'click', [target('b', 5), target('c', 5)])],
    sessions: sessions(10),
  });
  const cand = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 1)])],
    sessions: sessions(1),
  });
  // Even a replayer that would "confirm" is never consulted — no candidate regression.
  const replayer = replayerFrom({ 'a|a:click': { reached: false } });
  const alarms = await detectRegressionAlarms(base, cand, { replayer });
  assert.equal(alarms.length, 0);
});

test('acceptance: stale model but live app fine ⇒ replay prevents the false alarm', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  // Candidate run happened not to reproduce the edge (flaky capture), but the
  // live target still reaches b on replay.
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  const replayer = replayerFrom({ 'a|a:click': { reached: true, toState: 'b' } });
  const alarms = await detectRegressionAlarms(base, cand, { replayer });
  assert.equal(alarms.length, 0);
});

test('replay reclassifies a disappearance into a target change', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  const replayer = replayerFrom({
    'a|a:click': { reached: true, toState: 'x', toUrlTemplate: '/x' },
  });
  const alarms = await detectRegressionAlarms(base, cand, { replayer });
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].kind, 'edge_target_changed');
  assert.equal(alarms[0].evidence.replay?.toUrlTemplate, '/x');
});

test('without a replayer, candidate regressions are returned unconfirmed', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  const cand = model({
    states: [state('a', '/')],
    transitions: [],
    sessions: sessions(1),
  });
  const alarms = await detectRegressionAlarms(base, cand);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].confirmation, undefined);
});

// ---------------------------------------------------------------------------
// Reporting + triage payloads
// ---------------------------------------------------------------------------

test('toAlarmRecord flattens an alarm into a report record', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/dashboard')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  const cand = model({ states: [state('a', '/')], transitions: [], sessions: sessions(1) });
  const replayer = replayerFrom({ 'a|a:click': { reached: false } });
  const [alarm] = await detectRegressionAlarms(base, cand, { replayer });
  const rec = toAlarmRecord(alarm);
  assert.equal(rec.kind, 'edge_disappeared');
  assert.equal(rec.confirmed, true);
  assert.equal(rec.fromUrlTemplate, '/');
  assert.deepEqual(rec.expectedTargets, ['/dashboard']);
  assert.deepEqual(rec.observedTargets, []);
  assert.equal(rec.replayLanded, 'nowhere');
});

test('triageAlarms attaches an injected verdict', async () => {
  const base = model({
    states: [state('a', '/'), state('b', '/b')],
    transitions: [edge('a', 'click', [target('b', 8)])],
    sessions: sessions(8),
  });
  const cand = model({ states: [state('a', '/')], transitions: [], sessions: sessions(1) });
  const replayer = replayerFrom({ 'a|a:click': { reached: false } });
  const alarms = await detectRegressionAlarms(base, cand, { replayer });
  const triaged = await triageAlarms(alarms, async () => ({
    surface: true,
    severity: 'high',
    note: 'login link gone',
  }));
  assert.equal(triaged.length, 1);
  assert.equal(triaged[0].verdict?.severity, 'high');
  assert.equal(triaged[0].record.kind, 'edge_disappeared');
});

test('DEFAULT_STABILITY_CONFIG is exported for callers', () => {
  assert.equal(typeof DEFAULT_STABILITY_CONFIG.minObservations, 'number');
});
