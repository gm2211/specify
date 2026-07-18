import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StepObservation } from '../agent/observation.js';
import type { CapturedTraffic } from '../capture/types.js';
import {
  learn,
  mergeSessions,
  enforceCap,
  stateId,
  actionKey,
  ModelStore,
  modelPath,
  loadModel,
  saveModel,
  DEFAULT_ABSTRACTION_CONFIG,
  type SessionTrace,
  type NavModel,
  type PredicateExtractor,
} from './nav-model.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function step(
  partial: Partial<StepObservation> & { action: string; urlBefore: string; urlAfter: string },
): StepObservation {
  // Deterministic timestamps keyed to the step index so fixtures reproduce
  // byte-identically across repeated learn() calls.
  const idx = partial.step ?? 0;
  const tsStart = 1000 + idx * 10;
  const tsEnd = tsStart + 5;
  return {
    step: idx,
    action: partial.action,
    args: partial.args,
    success: partial.success ?? true,
    urlBefore: partial.urlBefore,
    urlAfter: partial.urlAfter,
    title: partial.title,
    tsStart: partial.tsStart ?? tsStart,
    tsEnd: partial.tsEnd ?? tsEnd,
    ax: partial.ax ?? { unchanged: true, digest: 'd0' },
    trafficRange: partial.trafficRange ?? [0, 0],
    consoleRange: partial.consoleRange ?? [0, 0],
  };
}

function traffic(method: string, url: string, status: number): CapturedTraffic {
  return {
    url,
    method,
    postData: null,
    status,
    contentType: 'application/json',
    ts: Date.now(),
    responseBody: null,
  };
}

/** A simple 3-page login flow: home -> click login -> goto dashboard. */
function loginSession(ref: string): SessionTrace {
  return {
    ref,
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://app.test/' },
        urlBefore: 'https://app.test/',
        urlAfter: 'https://app.test/',
        ax: { file: 'observations/ax/000.yaml', digest: 'home' },
      }),
      step({
        step: 1,
        action: 'browser_click',
        args: { selector: '#login' },
        urlBefore: 'https://app.test/',
        urlAfter: 'https://app.test/login',
        ax: { file: 'observations/ax/001.yaml', digest: 'login' },
      }),
      step({
        step: 2,
        action: 'browser_goto',
        args: { url: 'https://app.test/dashboard' },
        urlBefore: 'https://app.test/login',
        urlAfter: 'https://app.test/dashboard',
        ax: { file: 'observations/ax/002.yaml', digest: 'dash' },
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('stateId ignores predicate key order', () => {
  const a = stateId('/x', { b: true, a: false });
  const b = stateId('/x', { a: false, b: true });
  assert.equal(a, b);
});

test('stateId differs when a predicate bit flips', () => {
  assert.notEqual(stateId('/x', { a: true }), stateId('/x', { a: false }));
});

test('actionKey combines action type and selector', () => {
  assert.equal(actionKey('click', '#a'), actionKey('click', '#a'));
  assert.notEqual(actionKey('click', '#a'), actionKey('click', '#b'));
  assert.notEqual(actionKey('click', '#a'), actionKey('goto', '#a'));
});

// ---------------------------------------------------------------------------
// Learning basics
// ---------------------------------------------------------------------------

test('learn builds states and transitions from a step stream', () => {
  const model = learn('spec1', 'web_app.test', [loginSession('run-1')]);

  // home, login, dashboard => 3 distinct URL-template states (default: no predicates).
  assert.equal(model.states.length, 3);
  const templates = model.states.map((s) => s.urlTemplate).sort();
  assert.deepEqual(templates, ['/', '/dashboard', '/login']);

  // Two transitions: home->login (click), login->dashboard (goto).
  assert.equal(model.transitions.length, 2);
  for (const tr of model.transitions) {
    assert.equal(tr.targets.length, 1);
    assert.equal(tr.targets[0].count, 1);
  }

  assert.deepEqual(model.sessions, ['run-1']);
  assert.equal(model.truncated, false);
  assert.equal(model.coarsened, false);
});

test('recipe records action + selector, and value template for navigations', () => {
  const model = learn('spec1', 'web_app.test', [loginSession('run-1')]);
  const click = model.transitions.find((t) => t.recipe.action === 'browser_click')!;
  assert.equal(click.recipe.selector, '#login');
  assert.equal(click.recipe.valueTemplate, undefined);

  const goto = model.transitions.find(
    (t) => t.recipe.action === 'browser_goto' && t.recipe.valueTemplate === '/dashboard',
  );
  assert.ok(goto, 'a goto edge carries the templated destination URL');
});

test('seenCount counts every visit to a state', () => {
  // home visited twice (start + return), login once.
  const session: SessionTrace = {
    ref: 'r',
    steps: [
      step({
        step: 0,
        action: 'goto',
        args: { url: 'https://app.test/' },
        urlBefore: 'https://app.test/',
        urlAfter: 'https://app.test/',
      }),
      step({
        step: 1,
        action: 'click',
        args: { selector: '#a' },
        urlBefore: 'https://app.test/',
        urlAfter: 'https://app.test/login',
      }),
      step({
        step: 2,
        action: 'back',
        args: {},
        urlBefore: 'https://app.test/login',
        urlAfter: 'https://app.test/',
      }),
    ],
  };
  const model = learn('s', 't', [session]);
  const home = model.states.find((x) => x.urlTemplate === '/')!;
  const login = model.states.find((x) => x.urlTemplate === '/login')!;
  // Step 0 is the initial goto (entry). Real walk = [home(entry), login, home(back)]
  // => home 2, login 1.
  assert.equal(home.seenCount, 2);
  assert.equal(login.seenCount, 1);
});

// ---------------------------------------------------------------------------
// Determinism / idempotency
// ---------------------------------------------------------------------------

test('learn is order-independent across sessions', () => {
  const a = loginSession('run-a');
  const b = loginSession('run-b');
  const m1 = learn('s', 't', [a, b]);
  const m2 = learn('s', 't', [b, a]);
  assert.deepEqual(JSON.stringify(m1), JSON.stringify(m2));
});

test('learn dedups sessions by ref (re-learning is idempotent)', () => {
  const s = loginSession('run-1');
  const once = learn('s', 't', [s]);
  const twice = learn('s', 't', [s, s]);
  assert.deepEqual(JSON.stringify(once), JSON.stringify(twice));
});

test('mergeSessions(learn(S), S) === learn(S)', () => {
  const S = [loginSession('run-1'), loginSession('run-2')];
  const base = learn('s', 't', S);
  const merged = mergeSessions(base, S);
  assert.deepEqual(JSON.stringify(merged), JSON.stringify(base));
});

test('mergeSessions folds a genuinely new session incrementally', () => {
  const base = learn('s', 't', [loginSession('run-1')]);
  const extra: SessionTrace = {
    ref: 'run-2',
    steps: [
      step({
        step: 0,
        action: 'goto',
        args: { url: 'https://app.test/settings' },
        urlBefore: 'https://app.test/',
        urlAfter: 'https://app.test/settings',
      }),
    ],
  };
  const merged = mergeSessions(base, [extra]);
  assert.deepEqual(merged.sessions, ['run-1', 'run-2']);
  assert.ok(merged.states.some((x) => x.urlTemplate === '/settings'));
});

// ---------------------------------------------------------------------------
// Nondeterminism (multiple targets)
// ---------------------------------------------------------------------------

test('same (from, action) reaching two destinations yields a nondeterministic edge', () => {
  // Two runs: clicking #go lands on /a in one, /b in another (A/B test).
  const runA: SessionTrace = {
    ref: 'A',
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://x.test/' },
        urlBefore: 'about:blank',
        urlAfter: 'https://x.test/',
      }),
      step({
        step: 1,
        action: 'click',
        args: { selector: '#go' },
        urlBefore: 'https://x.test/',
        urlAfter: 'https://x.test/a',
      }),
    ],
  };
  const runB: SessionTrace = {
    ref: 'B',
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://x.test/' },
        urlBefore: 'about:blank',
        urlAfter: 'https://x.test/',
      }),
      step({
        step: 1,
        action: 'click',
        args: { selector: '#go' },
        urlBefore: 'https://x.test/',
        urlAfter: 'https://x.test/b',
      }),
    ],
  };
  const model = learn('s', 't', [runA, runB]);
  const edge = model.transitions.find((t) => t.recipe.selector === '#go')!;
  assert.equal(edge.targets.length, 2);
  const dests = edge.targets
    .map((t) => model.states.find((s) => s.id === t.to)!.urlTemplate)
    .sort();
  assert.deepEqual(dests, ['/a', '/b']);
  for (const target of edge.targets) assert.equal(target.count, 1);
});

test('repeated identical arc increments count and merges signatures', () => {
  const mk = (ref: string): SessionTrace => ({
    ref,
    traffic: [traffic('GET', 'https://x.test/api/data', 200)],
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://x.test/' },
        urlBefore: 'about:blank',
        urlAfter: 'https://x.test/',
      }),
      step({
        step: 1,
        action: 'click',
        args: { selector: '#go' },
        urlBefore: 'https://x.test/',
        urlAfter: 'https://x.test/a',
        trafficRange: [0, 1],
      }),
    ],
  });
  const model = learn('s', 't', [mk('A'), mk('B')]);
  const edge = model.transitions.find((t) => t.recipe.selector === '#go')!;
  assert.equal(edge.targets.length, 1);
  assert.equal(edge.targets[0].count, 2);
  assert.deepEqual(edge.targets[0].networkSignature, [
    { method: 'GET', urlTemplate: '/api/data', statusClass: '2xx' },
  ]);
});

// ---------------------------------------------------------------------------
// Network signatures
// ---------------------------------------------------------------------------

test('network signature is templated, status-classed, and deduped', () => {
  const session: SessionTrace = {
    ref: 'r',
    traffic: [
      traffic('GET', 'https://x.test/users/1', 200),
      traffic('GET', 'https://x.test/users/2', 200),
      traffic('POST', 'https://x.test/users/3', 500),
    ],
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://x.test/' },
        urlBefore: 'about:blank',
        urlAfter: 'https://x.test/',
      }),
      step({
        step: 1,
        action: 'click',
        args: { selector: '#go' },
        urlBefore: 'https://x.test/',
        urlAfter: 'https://x.test/list',
        trafficRange: [0, 3],
      }),
    ],
  };
  const model = learn('s', 't', [session], { config: { minDistinctForParam: 2 } });
  const edge = model.transitions.find((t) => t.recipe.selector === '#go')!;
  const sig = edge.targets[0].networkSignature;
  // /users/1 and /users/2 both GET 2xx collapse to one entry after templating.
  assert.deepEqual(sig, [
    { method: 'GET', urlTemplate: '/users/:id', statusClass: '2xx' },
    { method: 'POST', urlTemplate: '/users/:id', statusClass: '5xx' },
  ]);
});

// ---------------------------------------------------------------------------
// URL templating collapses per-entity states
// ---------------------------------------------------------------------------

test('per-entity URLs collapse to a single template state', () => {
  const mk = (id: number): SessionTrace => ({
    ref: `r${id}`,
    steps: [
      step({
        step: 0,
        action: 'goto',
        args: { url: `https://x.test/users/${id}` },
        urlBefore: 'https://x.test/',
        urlAfter: `https://x.test/users/${id}`,
      }),
    ],
  });
  const model = learn('s', 't', [mk(1), mk(2), mk(3)]);
  const userStates = model.states.filter((x) => x.urlTemplate.startsWith('/users'));
  assert.equal(userStates.length, 1);
  assert.equal(userStates[0].urlTemplate, '/users/:id');
  assert.equal(userStates[0].seenCount, 3); // reached once per run
});

// ---------------------------------------------------------------------------
// Predicate extractor (opt-in)
// ---------------------------------------------------------------------------

test('opt-in predicates split one URL template into distinct states', () => {
  const extractor: PredicateExtractor = (ctx) => ({ dashboard: ctx.urlTemplate === '/dashboard' });
  const model = learn('s', 't', [loginSession('r')], { predicates: extractor });
  const dash = model.states.find((x) => x.urlTemplate === '/dashboard')!;
  assert.deepEqual(dash.predicates, { dashboard: true });
  const home = model.states.find((x) => x.urlTemplate === '/')!;
  assert.deepEqual(home.predicates, { dashboard: false });
  // stateId embeds predicates.
  assert.equal(dash.id, stateId('/dashboard', { dashboard: true }));
});

// ---------------------------------------------------------------------------
// State cap
// ---------------------------------------------------------------------------

function manyDistinctPages(n: number): SessionTrace {
  const steps: StepObservation[] = [];
  for (let i = 0; i < n; i++) {
    steps.push(
      step({
        step: i,
        action: 'goto',
        args: { url: `https://x.test/p${i}` },
        urlBefore: 'https://x.test/',
        urlAfter: `https://x.test/p${i}`,
      }),
    );
  }
  return { ref: 'big', steps };
}

test('coarsen strategy drops predicate bits to fit under the cap', () => {
  // Predicate makes 2 states per URL template; coarsening collapses them.
  const flipFlop: PredicateExtractor = (ctx) => ({ marker: ctx.url.endsWith('/a') });
  const session: SessionTrace = {
    ref: 'r',
    steps: [
      step({
        step: 0,
        action: 'goto',
        args: { url: 'https://x.test/page/a' },
        urlBefore: 'https://x.test/',
        urlAfter: 'https://x.test/page/a',
      }),
      step({
        step: 1,
        action: 'goto',
        args: { url: 'https://x.test/page/b' },
        urlBefore: 'https://x.test/page/a',
        urlAfter: 'https://x.test/page/b',
      }),
    ],
  };
  // Entry state /page/a (marker=t) + /page/b (marker=f) = 2 states.
  const uncapped = learn('s', 't', [session], { predicates: flipFlop });
  assert.equal(uncapped.states.length, 2);

  // Cap 1, coarsen: /page/a and /page/b are distinct literal templates, so
  // dropping predicates still leaves 2 template states > 1 — coarsening runs
  // but falls through to truncation.
  const capped = learn('s', 't', [session], {
    predicates: flipFlop,
    config: { maxStates: 1, overflow: 'coarsen', minDistinctForParam: 8 },
  });
  assert.equal(capped.states.length, 1);
  assert.equal(capped.coarsened, true);
  assert.equal(capped.truncated, true);
});

test('coarsen alone suffices when predicates are the only over-cap driver', () => {
  const marker: PredicateExtractor = (ctx) => ({ m: ctx.url.includes('x=1') });
  const session: SessionTrace = {
    ref: 'r',
    steps: [
      step({
        step: 0,
        action: 'goto',
        args: { url: 'https://x.test/p?x=1' },
        urlBefore: 'https://x.test/p?x=1',
        urlAfter: 'https://x.test/p?x=1',
      }),
      step({
        step: 1,
        action: 'goto',
        args: { url: 'https://x.test/p?x=2' },
        urlBefore: 'https://x.test/p?x=1',
        urlAfter: 'https://x.test/p?x=2',
      }),
    ],
  };
  // Two predicate variants of the same template /p => 2 states uncapped.
  const uncapped = learn('s', 't', [session], { predicates: marker });
  assert.equal(uncapped.states.length, 2);
  // Cap 1, coarsen: collapse to single /p template state, no truncation needed.
  const capped = learn('s', 't', [session], {
    predicates: marker,
    config: { maxStates: 1, overflow: 'coarsen', minDistinctForParam: 8 },
  });
  assert.equal(capped.states.length, 1);
  assert.equal(capped.coarsened, true);
  assert.equal(capped.truncated, false);
});

test('stop strategy keeps the most-visited states and drops dangling edges', () => {
  const session = manyDistinctPages(10);
  // High param threshold so the /p0../p9 literals stay distinct states instead
  // of collapsing to a /:id template — the point here is to exceed the cap.
  const model = learn('s', 't', [session], {
    config: { maxStates: 3, overflow: 'stop', minDistinctForParam: 100 },
  });
  assert.equal(model.states.length, 3);
  assert.equal(model.truncated, true);
  assert.equal(model.coarsened, false);
  // The home state (visited 10x) survives; every kept edge references kept states.
  const ids = new Set(model.states.map((s) => s.id));
  for (const tr of model.transitions) {
    assert.ok(ids.has(tr.from));
    for (const t of tr.targets) assert.ok(ids.has(t.to));
  }
});

test('enforceCap is a no-op under the cap', () => {
  const model = learn('s', 't', [loginSession('r')]);
  const same = enforceCap(model, DEFAULT_ABSTRACTION_CONFIG);
  assert.deepEqual(JSON.stringify(same), JSON.stringify(model));
});

// ---------------------------------------------------------------------------
// Persistence / store
// ---------------------------------------------------------------------------

test('modelPath mirrors the memory-store layout', () => {
  const p = modelPath('/root', 'my spec', 'web_app.test');
  assert.equal(p, path.join('/root', '.specify', 'model', 'my_spec', 'web_app.test.json'));
});

test('save/load round-trips a model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    const file = path.join(dir, 'm.json');
    const model = learn('s', 't', [loginSession('r')]);
    saveModel(file, model);
    const loaded = loadModel(file);
    assert.deepEqual(loaded, model);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadModel returns null for missing or corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    assert.equal(loadModel(path.join(dir, 'nope.json')), null);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json', 'utf-8');
    assert.equal(loadModel(bad), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelStore.update is idempotent across re-runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    const store = new ModelStore({ specRootDir: dir, specId: 's', targetKey: 'web_app.test' });
    const first = store.update([loginSession('run-1')]);
    const second = store.update([loginSession('run-1')]);
    assert.deepEqual(JSON.stringify(first), JSON.stringify(second));
    // Adding a new run grows the model.
    const third = store.update([loginSession('run-2')]);
    assert.deepEqual(third.sessions, ['run-1', 'run-2']);
    // Persisted artifact matches the returned model.
    const onDisk = loadModel(store.filePath) as NavModel;
    assert.deepEqual(JSON.stringify(onDisk), JSON.stringify(third));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelStore.update re-applies its fold when a concurrent writer lands mid-window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    const options = { specRootDir: dir, specId: 's', targetKey: 'web_app.test' } as const;
    const storeA = new ModelStore(options);
    storeA.update([loginSession('run-1')]);

    // Simulate a concurrent fold on the same target landing between this
    // update's load and its pre-write recheck (the onLoadedForTest seam).
    // Without the guard, run-3 would be silently clobbered by run-2's write.
    const storeB = new ModelStore(options);
    const result = storeB.update([loginSession('run-2')], {}, () => {
      new ModelStore(options).update([loginSession('run-3')]);
    });

    // Both writers' sessions survive: the interrupted update folded run-2
    // onto the fresh on-disk model that already contained run-1 and run-3.
    assert.deepEqual(result.sessions, ['run-1', 'run-2', 'run-3']);
    const onDisk = loadModel(storeB.filePath) as NavModel;
    assert.deepEqual(onDisk.sessions, ['run-1', 'run-2', 'run-3']);
    assert.deepEqual(JSON.stringify(onDisk), JSON.stringify(result));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelStore.update falls back to its own model when the file vanishes mid-window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    const options = { specRootDir: dir, specId: 's', targetKey: 'web_app.test' } as const;
    const store = new ModelStore(options);
    store.update([loginSession('run-1')]);

    const result = store.update([loginSession('run-2')], {}, () => {
      fs.rmSync(store.filePath);
    });

    // The computed fold (run-1 + run-2) still wins over an empty disk.
    assert.deepEqual(result.sessions, ['run-1', 'run-2']);
    const onDisk = loadModel(store.filePath) as NavModel;
    assert.deepEqual(onDisk.sessions, ['run-1', 'run-2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actionKey inputs are delimited (no cross-boundary collisions)', () => {
  // Without a delimiter between action and selector these two would hash the
  // same ("click" + "k#a" vs "clic" + "#a" style shifts).
  assert.notEqual(actionKey('click', 'x#a'), actionKey('clickx', '#a'));
  assert.notEqual(stateId('/ax', {}), stateId('/a', { x: true }));
});

test('mergeSessions prunes states orphaned by template re-inference', () => {
  // 8 distinct /blog/<slug> literals stay literal under the default threshold
  // (minDistinctForParam=8 means 9+ distinct values parameterize).
  const slugs = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const mk = (slug: string): SessionTrace => ({
    ref: `run-${slug}`,
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://x.test/' },
        urlBefore: 'about:blank',
        urlAfter: 'https://x.test/',
      }),
      step({
        step: 1,
        action: 'browser_goto',
        args: { url: `https://x.test/blog/${slug}` },
        urlBefore: 'https://x.test/',
        urlAfter: `https://x.test/blog/${slug}`,
      }),
    ],
  });

  const base = learn(
    's',
    't',
    slugs.map((slug) => mk(slug)),
  );
  // 1 home + 8 literal /blog/<slug> states.
  assert.equal(base.states.length, 9);
  assert.ok(base.states.every((s) => !s.urlTemplate.includes(':')));
  assert.equal(base.orphanedStatesPruned, 0);

  // The 9th distinct slug crosses the threshold: /blog/:id appears and the 8
  // literal templates are no longer produced by any source URL.
  const merged = mergeSessions(base, [mk('india')]);
  const templates = merged.states.map((s) => s.urlTemplate).sort();
  assert.deepEqual(templates, ['/', '/blog/:id']);
  assert.equal(merged.orphanedStatesPruned, 8);
  // No transition may reference a pruned state.
  const ids = new Set(merged.states.map((s) => s.id));
  for (const tr of merged.transitions) {
    assert.ok(ids.has(tr.from));
    for (const t of tr.targets) assert.ok(ids.has(t.to));
  }
});

test('mergeSessions throws on predicate-extractor fingerprint mismatch', () => {
  const withKeys: PredicateExtractor = (ctx) => ({ dashboard: ctx.urlTemplate === '/dashboard' });
  const model = learn('s', 't', [loginSession('run-1')], { predicates: withKeys });
  assert.deepEqual(model.predicateKeys, ['dashboard']);

  // Omitting the extractor on merge must throw, not silently mint bare ids.
  assert.throws(
    () => mergeSessions(model, [loginSession('run-2')]),
    /predicate extractor mismatch.*\[dashboard\].*\[\]/s,
  );

  // A different extractor must throw too.
  const otherKeys: PredicateExtractor = () => ({ hasForm: false });
  assert.throws(
    () => mergeSessions(model, [loginSession('run-2')], { predicates: otherKeys }),
    /predicate extractor mismatch/,
  );

  // The matching extractor still merges fine.
  const ok = mergeSessions(model, [loginSession('run-2')], { predicates: withKeys });
  assert.deepEqual(ok.sessions, ['run-1', 'run-2']);
  assert.deepEqual(ok.predicateKeys, ['dashboard']);
});

test('saveModel writes atomically (no .tmp leftover)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    const file = path.join(dir, 'm.json');
    const model = learn('s', 't', [loginSession('r')]);
    saveModel(file, model);
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(file + '.tmp'));
    assert.deepEqual(loadModel(file), model);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('truncation on a nondeterministic edge keeps the surviving targets', () => {
  const run = (ref: string, dest: string): SessionTrace => ({
    ref,
    steps: [
      step({
        step: 0,
        action: 'browser_goto',
        args: { url: 'https://x.test/' },
        urlBefore: 'about:blank',
        urlAfter: 'https://x.test/',
      }),
      step({
        step: 1,
        action: 'click',
        args: { selector: '#go' },
        urlBefore: 'https://x.test/',
        urlAfter: `https://x.test/${dest}`,
      }),
    ],
  });
  // home seen 3x, /a seen 2x, /b seen 1x. Cap 2 with 'stop' keeps home + /a,
  // dropping /b — the #go edge must survive with its /a target (and count)
  // intact rather than being dropped wholesale.
  const model = learn('s', 't', [run('A1', 'a'), run('A2', 'a'), run('B', 'b')], {
    config: { maxStates: 2, overflow: 'stop', minDistinctForParam: 100 },
  });
  assert.equal(model.truncated, true);
  const edge = model.transitions.find((t) => t.recipe.selector === '#go')!;
  assert.equal(edge.targets.length, 1);
  const dest = model.states.find((s) => s.id === edge.targets[0].to)!;
  assert.equal(dest.urlTemplate, '/a');
  assert.equal(edge.targets[0].count, 2);
});

test('ModelStore.rebuild overwrites via batch learn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navmodel-'));
  try {
    const store = new ModelStore({ specRootDir: dir, specId: 's', targetKey: 'web_app.test' });
    const built = store.rebuild([loginSession('run-1'), loginSession('run-2')]);
    const direct = learn('s', 'web_app.test', [loginSession('run-1'), loginSession('run-2')]);
    assert.deepEqual(JSON.stringify(built), JSON.stringify(direct));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
