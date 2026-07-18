import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  NavModel,
  ModelState,
  ModelTransition,
  Recipe,
  NetworkSignatureEntry,
} from './nav-model.js';
import { generateTraceSuite, type Trace, type TraceSuite } from './walker.js';
import {
  mutateSuite,
  defaultFlowClassifier,
  renderMutationSummary,
  mutatedStepActions,
  ALL_OPERATORS,
  MUTATION_OPERATORS,
  type MutationSuite,
  type MutatedTrace,
  type FlowClassifier,
  type MutationOperatorName,
} from './mutators.js';

// ---------------------------------------------------------------------------
// Fixture builders — hand-built models with predicates + network signatures so
// the semantic-signal operators have something to bite on.
// ---------------------------------------------------------------------------

function state(id: string, urlTemplate: string, predicates: Record<string, boolean> = {}): ModelState {
  return { id, urlTemplate, predicates, seenCount: 1, examples: [] };
}

function shortActionKey(action: string, selector: string): string {
  return `${action}:${selector}`;
}

interface EdgeOpts {
  selector?: string;
  signature?: NetworkSignatureEntry[];
}

function edge(from: string, action: string, to: string, opts: EdgeOpts = {}): ModelTransition {
  const selector = opts.selector ?? `#${from}-${to}`;
  const recipe: Recipe = { action, selector };
  return {
    from,
    actionKey: shortActionKey(action, selector),
    recipe,
    targets: [{ to, count: 1, lastSeen: 1, networkSignature: opts.signature ?? [] }],
  };
}

function sig(method: string, urlTemplate: string, statusClass: NetworkSignatureEntry['statusClass']): NetworkSignatureEntry {
  return { method, urlTemplate, statusClass };
}

function wrapModel(states: ModelState[], transitions: ModelTransition[]): NavModel {
  return {
    version: 2,
    specId: 'spec',
    targetKey: 'target',
    abstractionConfig: { maxStates: 500, overflow: 'coarsen', minDistinctForParam: 8 },
    states,
    transitions,
    sessions: ['s1'],
    templates: { sourceUrls: [], params: [] } as unknown as NavModel['templates'],
    predicateKeys: ['authenticated', 'terminal'],
    orphanedStatesPruned: 0,
    truncated: false,
    coarsened: false,
  };
}

/**
 * A login → dashboard → checkout → confirmation flow with a logout edge:
 *
 *   LOGIN(/login) --submit[POST /session]--> DASH(/dashboard, auth)
 *   DASH --pay[POST /pay]--> CHECKOUT(/checkout, auth)
 *   CHECKOUT --confirm[POST /orders]--> DONE(/confirmation, auth+terminal)
 *   DASH --logout--> LOGIN                        (leaves auth)
 */
function checkoutModel(): NavModel {
  const states = [
    state('LOGIN', '/login'),
    state('DASH', '/dashboard', { authenticated: true, terminal: false }),
    state('CHECKOUT', '/checkout', { authenticated: true, terminal: false }),
    state('DONE', '/confirmation', { authenticated: true, terminal: true }),
  ];
  const transitions = [
    edge('LOGIN', 'browser_click', 'DASH', {
      selector: '#login',
      signature: [sig('POST', '/session', '2xx')],
    }),
    edge('DASH', 'browser_click', 'CHECKOUT', {
      selector: '#pay',
      signature: [sig('POST', '/pay', '2xx')],
    }),
    edge('CHECKOUT', 'browser_click', 'DONE', {
      selector: '#confirm',
      signature: [sig('POST', '/orders', '2xx')],
    }),
    edge('DASH', 'browser_click', 'LOGIN', {
      selector: '#logout',
      signature: [sig('GET', '/login', '2xx')],
    }),
  ];
  return wrapModel(states, transitions);
}

/**
 * Build a single hand-made source suite whose one trace walks the full path
 * LOGIN → DASH → CHECKOUT → DONE, then DASH → LOGIN (logout). Using a fixed
 * trace keeps operator assertions precise regardless of walker heuristics.
 */
function manualSuite(model: NavModel, transitionsSpec: Array<[string, string, string]>): TraceSuite {
  const byArc = new Map<string, { actionKey: string; recipe: Recipe; signature: NetworkSignatureEntry[] }>();
  for (const tr of model.transitions) {
    for (const t of tr.targets) {
      byArc.set(`${tr.from}->${t.to}`, {
        actionKey: tr.actionKey,
        recipe: tr.recipe,
        signature: t.networkSignature,
      });
    }
  }
  const urlOf = new Map(model.states.map((s) => [s.id, s.urlTemplate]));
  const transitions = transitionsSpec.map(([from, , to]) => {
    const info = byArc.get(`${from}->${to}`)!;
    return {
      arc: `${from}|${info.actionKey}|${to}`,
      from,
      actionKey: info.actionKey,
      to,
      recipe: info.recipe,
      fromUrlTemplate: urlOf.get(from)!,
      toUrlTemplate: urlOf.get(to)!,
    };
  });
  const startState = transitionsSpec[0][0];
  const trace: Trace = {
    id: 't0',
    startState,
    startUrlTemplate: urlOf.get(startState)!,
    transitions,
  };
  return {
    version: 1,
    specId: model.specId,
    targetKey: model.targetKey,
    modelVersion: model.version,
    modelHash: 'deadbeefdeadbeef',
    seed: 1,
    criteria: ['all-transitions'],
    budget: { maxWalkLength: 50, maxWalks: 200 },
    traces: [trace],
    coverage: {
      states: { known: 0, covered: 0, ratio: 1, uncovered: [] },
      transitions: { known: 0, covered: 0, ratio: 1, uncovered: [] },
    },
    truncated: false,
  };
}

function fullCheckoutSuite(model: NavModel): TraceSuite {
  return manualSuite(model, [
    ['LOGIN', 'x', 'DASH'],
    ['DASH', 'x', 'CHECKOUT'],
    ['CHECKOUT', 'x', 'DONE'],
  ]);
}

function logoutSuite(model: NavModel): TraceSuite {
  // DASH --logout--> LOGIN. from=DASH (auth), to=LOGIN (non-auth) => auth exit.
  return manualSuite(model, [['DASH', 'x', 'LOGIN']]);
}

function byOperator(suite: MutationSuite, op: MutationOperatorName): MutatedTrace[] {
  return suite.mutations.filter((m) => m.operator === op);
}

// ---------------------------------------------------------------------------
// Operator coverage matrix — every operator fires on the right fixture.
// ---------------------------------------------------------------------------

test('double-submit fires once per write-bearing transition, tolerate contract', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const ds = byOperator(suite, 'double-submit');
  // Three POST-bearing arcs on the path.
  assert.equal(ds.length, 3);
  for (const m of ds) {
    assert.equal(m.contract.class, 'no-second-side-effect');
    assert.equal(m.contract.outcome, 'tolerate');
    assert.equal(m.contract.check.kind, 'no-repeated-write');
    if (m.contract.check.kind === 'no-repeated-write') {
      // Conservative policy: a repeated 2xx is inconclusive (idempotent retry
      // vs duplicate), never a violation on its own.
      assert.equal(m.contract.check.onRepeatedSuccess, 'inconclusive');
    }
    assert.ok(m.wellFormed, 'a re-fired real arc keeps the path well-formed');
  }
});

test('double-submit inserts the duplicate immediately after the original', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  // The variant duplicating the first arc (LOGIN->DASH) has one extra step.
  const first = byOperator(suite, 'double-submit').find(
    (m) => m.contract.check.kind === 'no-repeated-write' && m.contract.check.injectedStepIndex === 1,
  )!;
  assert.ok(first);
  assert.equal(first.steps.length, 4); // 3 originals + 1 duplicate
  // steps[0] and steps[1] are the same arc (original then back-to-back duplicate).
  const s0 = first.steps[0];
  const s1 = first.steps[1];
  assert.ok(s0.kind === 'model' && s1.kind === 'model');
  assert.equal(s0.transition.arc, s1.transition.arc);
});

test('back-nav-after-auth-exit fires on a logout edge and injects a back step', () => {
  const model = checkoutModel();
  const suite = mutateSuite(logoutSuite(model), model);
  const bn = byOperator(suite, 'back-nav-after-auth-exit');
  assert.equal(bn.length, 1);
  const m = bn[0];
  assert.equal(m.contract.class, 'redirect-to-login-on-auth-loss');
  assert.equal(m.contract.outcome, 'tolerate');
  assert.equal(m.wellFormed, true); // valid-if-unusual: the app should stay safe
  const synthetic = m.steps.filter((s) => s.kind === 'synthetic');
  assert.equal(synthetic.length, 1);
  assert.equal(synthetic[0].kind === 'synthetic' && synthetic[0].action, 'browser_back');
});

test('back-nav does not fire when no transition leaves an authenticated state', () => {
  const model = checkoutModel();
  // LOGIN->DASH enters auth (does not leave it); DASH->CHECKOUT stays auth.
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  assert.equal(byOperator(suite, 'back-nav-after-auth-exit').length, 0);
});

test('session-clear-midflow injects a cookie clear before a later auth page', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const sc = byOperator(suite, 'session-clear-midflow');
  assert.ok(sc.length >= 1);
  for (const m of sc) {
    assert.equal(m.contract.class, 'redirect-to-login-on-auth-loss');
    assert.equal(m.contract.outcome, 'reject');
    assert.equal(m.contract.check.kind, 'expect-auth-redirect');
    assert.equal(m.wellFormed, false);
    const clears = m.steps.filter((s) => s.kind === 'synthetic' && s.action === 'browser_clear_cookies');
    assert.equal(clears.length, 1);
  }
});

test('revisit-after-terminal re-enters the terminal state with a goto', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const rv = byOperator(suite, 'revisit-after-terminal');
  // DONE is terminal (predicate + sink). CHECKOUT->DONE is the only arrival.
  assert.equal(rv.length, 1);
  const m = rv[0];
  assert.equal(m.contract.class, 'terminal-state-not-reprocessable');
  // DONE was reached by a POST arc => "no second charge" tolerate contract.
  assert.equal(m.contract.outcome, 'tolerate');
  assert.equal(m.contract.check.kind, 'no-repeated-write');
  const goto = m.steps[m.steps.length - 1];
  assert.ok(goto.kind === 'synthetic' && goto.action === 'browser_goto');
  assert.equal(goto.kind === 'synthetic' && goto.urlTemplate, '/confirmation');
});

test('direct-url-skip-prereqs starts mid-flow and records omitted prerequisites', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const du = byOperator(suite, 'direct-url-skip-prereqs');
  assert.ok(du.length >= 1);
  for (const m of du) {
    assert.equal(m.contract.class, 'reject-or-redirect-on-missing-prereq');
    assert.equal(m.contract.outcome, 'reject');
    assert.equal(m.contract.check.kind, 'expect-reject-or-redirect');
    assert.equal(m.wellFormed, false);
    if (m.contract.check.kind === 'expect-reject-or-redirect') {
      assert.ok(m.contract.check.omittedPrerequisites.length >= 1);
      assert.equal(m.contract.check.target, m.startState);
    }
  }
});

test('every operator is represented on a rich fixture (coverage matrix)', () => {
  const model = checkoutModel();
  // Combine both fixtures into one suite so the auth-exit operator has a target.
  const base = fullCheckoutSuite(model);
  const withLogout: TraceSuite = { ...base, traces: [...base.traces, ...logoutSuite(model).traces] };
  // Re-id the second trace so ids stay unique.
  withLogout.traces[1] = { ...withLogout.traces[1], id: 't1' };
  const suite = mutateSuite(withLogout, model);
  for (const op of ALL_OPERATORS) {
    assert.ok(suite.operatorCounts[op] > 0, `operator ${op} produced at least one variant`);
  }
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test('same seed produces a byte-identical mutation suite', () => {
  const model = checkoutModel();
  const src = fullCheckoutSuite(model);
  const a = mutateSuite(src, model, { seed: 7 });
  const b = mutateSuite(src, model, { seed: 7 });
  assert.deepEqual(a, b);
});

test('mutation choices are independent of operator iteration order', () => {
  const model = checkoutModel();
  const src = fullCheckoutSuite(model);
  const all = mutateSuite(src, model, { seed: 3 });
  // Running a single operator yields exactly the variants that operator
  // contributed to the full run — its PRNG is not perturbed by the others.
  const onlyDouble = mutateSuite(src, model, { seed: 3, operators: ['double-submit'] });
  assert.deepEqual(
    onlyDouble.mutations,
    all.mutations.filter((m) => m.operator === 'double-submit'),
  );
});

test('maxVariantsPerOperator caps variants deterministically', () => {
  const model = checkoutModel();
  const src = fullCheckoutSuite(model);
  const capped = mutateSuite(src, model, { seed: 1, maxVariantsPerOperator: 1 });
  assert.equal(byOperator(capped, 'double-submit').length, 1);
  // Re-running with the same seed picks the SAME single variant.
  const again = mutateSuite(src, model, { seed: 1, maxVariantsPerOperator: 1 });
  assert.deepEqual(byOperator(capped, 'double-submit'), byOperator(again, 'double-submit'));
});

test('seed defaults to the source suite seed', () => {
  const model = checkoutModel();
  const src = fullCheckoutSuite(model); // seed 1
  const withDefault = mutateSuite(src, model);
  const withExplicit = mutateSuite(src, model, { seed: 1 });
  assert.equal(withDefault.seed, 1);
  assert.deepEqual(withDefault, withExplicit);
});

// ---------------------------------------------------------------------------
// Well-formedness of mutated traces.
// ---------------------------------------------------------------------------

function knownArcs(model: NavModel): Set<string> {
  const s = new Set<string>();
  for (const tr of model.transitions) {
    for (const t of tr.targets) s.add(`${tr.from}|${tr.actionKey}|${t.to}`);
  }
  return s;
}

/**
 * Tolerant executability check: every model step must reference a REAL model
 * arc, and be reachable from where we plausibly are — either the current
 * cursor, an immediate re-fire of the previous step's from-state (double-
 * submit), or the state a preceding synthetic step landed on.
 */
function assertExecutable(m: MutatedTrace, model: NavModel): void {
  const arcs = knownArcs(model);
  let cursor = m.startState;
  let prevModelFrom: string | undefined;
  let afterSynthetic = false;
  for (const step of m.steps) {
    if (step.kind === 'model') {
      assert.ok(arcs.has(step.transition.arc), `${m.id}: arc ${step.transition.arc} must exist`);
      const reachable =
        step.transition.from === cursor ||
        step.transition.from === prevModelFrom || // re-fire (double-submit)
        afterSynthetic; // a synthetic step preceded it (back/clear/goto)
      assert.ok(reachable, `${m.id}: model step from ${step.transition.from} not reachable at ${cursor}`);
      prevModelFrom = step.transition.from;
      cursor = step.transition.to;
      afterSynthetic = false;
    } else {
      if (step.landsOn) cursor = step.landsOn;
      afterSynthetic = true;
    }
  }
}

test('wellFormed mirrors the contract outcome (tolerate ⇔ well-formed)', () => {
  const model = checkoutModel();
  const base = fullCheckoutSuite(model);
  const withLogout: TraceSuite = { ...base, traces: [...base.traces, ...logoutSuite(model).traces] };
  withLogout.traces[1] = { ...withLogout.traces[1], id: 't1' };
  const suite = mutateSuite(withLogout, model);
  for (const m of suite.mutations) {
    assert.equal(m.wellFormed, m.contract.outcome === 'tolerate', `${m.id} wellFormed vs outcome`);
  }
});

test('every variant is executable: model steps are real arcs, reachable in sequence', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  for (const m of suite.mutations) {
    assertExecutable(m, model);
  }
});

test('mutatedStepActions lists an action per step', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const m = suite.mutations.find((x) => x.steps.some((s) => s.kind === 'synthetic'))!;
  const actions = mutatedStepActions(m);
  assert.equal(actions.length, m.steps.length);
  assert.ok(actions.every((a) => typeof a === 'string' && a.length > 0));
});

// ---------------------------------------------------------------------------
// Provenance + contracts are attached and serializable.
// ---------------------------------------------------------------------------

test('every variant carries reproducible provenance', () => {
  const model = checkoutModel();
  const src = fullCheckoutSuite(model);
  const suite = mutateSuite(src, model, { seed: 9 });
  for (const m of suite.mutations) {
    assert.equal(m.seed, 9);
    assert.equal(m.source.modelHash, src.modelHash);
    assert.equal(m.source.specId, 'spec');
    assert.equal(m.source.targetKey, 'target');
    assert.equal(m.source.traceId, 't0');
    assert.ok(m.id.startsWith(`t0~${m.operator}~`), `id ${m.id} encodes trace + operator`);
    assert.match(m.id, /~\d+$/); // trailing ordinal
  }
});

test('the whole mutation suite round-trips through JSON (contracts are data-only)', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const roundTripped = JSON.parse(JSON.stringify(suite));
  assert.deepEqual(roundTripped, suite);
});

// ---------------------------------------------------------------------------
// Classifier + scoping.
// ---------------------------------------------------------------------------

test('inScope scoping suppresses operators outside the tagged flow', () => {
  const model = checkoutModel();
  // Scope to LOGIN only: no auth state is in scope, so auth-dependent ops stay quiet.
  const classifier = defaultFlowClassifier(model, { inScopeStateIds: new Set(['LOGIN']) });
  const suite = mutateSuite(fullCheckoutSuite(model), model, { classifier });
  assert.equal(byOperator(suite, 'session-clear-midflow').length, 0);
  assert.equal(byOperator(suite, 'revisit-after-terminal').length, 0);
});

test('a sink with no predicate is still terminal (structural signal)', () => {
  // A → B where B is a sink but carries no predicates at all.
  const model = wrapModel(
    [state('A', '/a'), state('B', '/b')],
    [edge('A', 'browser_click', 'B', { signature: [] })],
  );
  const suite = mutateSuite(manualSuite(model, [['A', 'x', 'B']]), model);
  const rv = byOperator(suite, 'revisit-after-terminal');
  assert.equal(rv.length, 1);
  // Reached by a non-write arc => safe-revisit contract: a redirect away OR a
  // safely re-shown completed view both pass; only a write on revisit violates.
  assert.equal(rv[0].contract.outcome, 'tolerate');
  assert.equal(rv[0].contract.check.kind, 'expect-safe-revisit');
  if (rv[0].contract.check.kind === 'expect-safe-revisit') {
    assert.equal(rv[0].contract.check.target, 'B');
  }
});

test('a custom classifier overrides the auth signal', () => {
  const model = checkoutModel();
  // Treat everything as authenticated: DASH->CHECKOUT etc. never "leave" auth,
  // but LOGIN->DASH now leaves from an auth LOGIN into auth DASH — no exit.
  const allAuth: FlowClassifier = {
    isAuthenticated: () => true,
    isTerminal: (s) => s.predicates.terminal === true,
    inScope: () => true,
  };
  const suite = mutateSuite(fullCheckoutSuite(model), model, { classifier: allAuth });
  // No auth-exit (never leaves auth).
  assert.equal(byOperator(suite, 'back-nav-after-auth-exit').length, 0);
});

// ---------------------------------------------------------------------------
// Empty / degenerate inputs.
// ---------------------------------------------------------------------------

test('an empty source suite yields an empty mutation suite', () => {
  const model = checkoutModel();
  const empty: TraceSuite = { ...fullCheckoutSuite(model), traces: [] };
  const suite = mutateSuite(empty, model);
  assert.deepEqual(suite.mutations, []);
  for (const op of ALL_OPERATORS) assert.equal(suite.operatorCounts[op], 0);
  for (const a of suite.applicability) {
    assert.equal(a.skippedReason, 'source suite has no traces');
  }
});

test('a model with no write arcs yields no double-submit variants', () => {
  const model = wrapModel(
    [state('A', '/a', { authenticated: true }), state('B', '/b', { authenticated: true })],
    [edge('A', 'browser_click', 'B', { signature: [sig('GET', '/b', '2xx')] })],
  );
  const suite = mutateSuite(manualSuite(model, [['A', 'x', 'B']]), model);
  assert.equal(byOperator(suite, 'double-submit').length, 0);
});

// ---------------------------------------------------------------------------
// Applicability report — the coverage gap must be visible, not silent.
// ---------------------------------------------------------------------------

test('operators that fired report their variant count with no skip reason', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  assert.equal(suite.applicability.length, ALL_OPERATORS.length);
  for (const a of suite.applicability) {
    assert.equal(a.variants, suite.operatorCounts[a.operator]);
    if (a.variants > 0) assert.equal(a.skippedReason, undefined);
    else assert.ok(a.skippedReason, `${a.operator} with 0 variants must carry a reason`);
  }
});

test('a model with no auth labels reports the auth operators as skipped, with the gap named', () => {
  // Same graph shape, but nothing labeled authenticated: the auth-dependent
  // operators are vacuous and MUST say so instead of silently emitting nothing.
  const model = wrapModel(
    [state('A', '/a'), state('B', '/b'), state('C', '/c')],
    [
      edge('A', 'browser_click', 'B', { signature: [sig('POST', '/b', '2xx')] }),
      edge('B', 'browser_click', 'C', { signature: [sig('POST', '/c', '2xx')] }),
    ],
  );
  const suite = mutateSuite(manualSuite(model, [['A', 'x', 'B'], ['B', 'x', 'C']]), model);
  const byOp = new Map(suite.applicability.map((a) => [a.operator, a]));
  assert.equal(byOp.get('back-nav-after-auth-exit')!.variants, 0);
  assert.match(byOp.get('back-nav-after-auth-exit')!.skippedReason!, /no authenticated-labeled states/);
  assert.equal(byOp.get('session-clear-midflow')!.variants, 0);
  assert.match(byOp.get('session-clear-midflow')!.skippedReason!, /no authenticated-labeled states/);
});

test('a model with no write arcs names that gap for double-submit', () => {
  const model = wrapModel(
    [state('A', '/a'), state('B', '/b')],
    [edge('A', 'browser_click', 'B', { signature: [sig('GET', '/b', '2xx')] })],
  );
  const suite = mutateSuite(manualSuite(model, [['A', 'x', 'B']]), model);
  const ds = suite.applicability.find((a) => a.operator === 'double-submit')!;
  assert.equal(ds.variants, 0);
  assert.match(ds.skippedReason!, /no write-bearing arcs/);
});

test('signal-present-but-unused reports the trace-level reason, not the model-level one', () => {
  const model = checkoutModel();
  // A trace that never leaves auth: LOGIN->DASH->CHECKOUT. The model HAS auth
  // labels and a logout edge, so the reason is about the traces, not the model.
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const bn = suite.applicability.find((a) => a.operator === 'back-nav-after-auth-exit')!;
  assert.equal(bn.variants, 0);
  assert.match(bn.skippedReason!, /no source trace contains a transition leaving/);
});

test('renderMutationSummary surfaces skipped operators', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const line = renderMutationSummary(suite);
  assert.match(line, /skipped: back-nav-after-auth-exit — /);
});

// ---------------------------------------------------------------------------
// Integration with the real walker.
// ---------------------------------------------------------------------------

test('mutates a real walker-generated suite end-to-end', () => {
  const model = checkoutModel();
  const walkerSuite = generateTraceSuite(model, { seed: 2, criteria: ['all-transitions'] });
  const suite = mutateSuite(walkerSuite, model, { seed: 2 });
  // The walker covers all four arcs, so at least the write + terminal operators fire.
  assert.ok(suite.mutations.length > 0);
  assert.equal(suite.modelHash, walkerSuite.modelHash);
  assert.equal(suite.sourceSeed, walkerSuite.seed);
  // Determinism carries through the walker → mutator pipeline.
  const again = mutateSuite(generateTraceSuite(model, { seed: 2, criteria: ['all-transitions'] }), model, {
    seed: 2,
  });
  assert.deepEqual(again, suite);
});

// ---------------------------------------------------------------------------
// Rendering + registry.
// ---------------------------------------------------------------------------

test('renderMutationSummary is a readable one-liner', () => {
  const model = checkoutModel();
  const suite = mutateSuite(fullCheckoutSuite(model), model);
  const line = renderMutationSummary(suite);
  assert.match(line, /Mutation suite: \d+ variants? \[/);
  assert.match(line, /double-submit \d+/);
});

test('the registry exposes exactly the declared operators', () => {
  assert.deepEqual(Object.keys(MUTATION_OPERATORS).sort(), [...ALL_OPERATORS].sort());
});
