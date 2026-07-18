import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  NavModel,
  ModelState,
  ModelTransition,
  Recipe,
  NetworkSignatureEntry,
} from './nav-model.js';
import { generateTraceSuite } from './walker.js';
import { mutateSuite, defaultFlowClassifier, type MutatedTrace } from './mutators.js';
import {
  compileMutatedTrace,
  compileMutationSuite,
  expandTemplate,
  urlTemplateToRegex,
  renderPlaywrightTest,
  PARAM_PLACEHOLDER,
  isWriteEntry,
} from './trace-compiler.js';

// ---------------------------------------------------------------------------
// Fixture builders (mirrors mutators.test.ts).
// ---------------------------------------------------------------------------

function state(
  id: string,
  urlTemplate: string,
  predicates: Record<string, boolean> = {},
): ModelState {
  return { id, urlTemplate, predicates, seenCount: 1, examples: [] };
}

function shortActionKey(action: string, selector: string): string {
  return `${action}:${selector}`;
}

interface EdgeOpts {
  selector?: string;
  signature?: NetworkSignatureEntry[];
  valueTemplate?: string;
}

function edge(from: string, action: string, to: string, opts: EdgeOpts = {}): ModelTransition {
  const selector = opts.selector ?? `#${from}-${to}`;
  const recipe: Recipe = { action, selector, valueTemplate: opts.valueTemplate };
  return {
    from,
    actionKey: shortActionKey(action, selector),
    recipe,
    targets: [{ to, count: 1, lastSeen: 1, networkSignature: opts.signature ?? [] }],
  };
}

function sig(
  method: string,
  urlTemplate: string,
  statusClass: NetworkSignatureEntry['statusClass'],
): NetworkSignatureEntry {
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
 * login → dashboard → checkout → confirmation with a logout edge. POST arcs on
 * the writes so double-submit / revisit operators find write signatures.
 */
function flowModel(): NavModel {
  const states = [
    state('LOGIN', '/login'),
    state('DASH', '/dashboard', { authenticated: true }),
    state('CHECKOUT', '/checkout', { authenticated: true }),
    state('DONE', '/confirmation', { authenticated: true, terminal: true }),
  ];
  const transitions = [
    edge('LOGIN', 'browser_click', 'DASH', {
      selector: '#submit',
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
    edge('DASH', 'browser_click', 'LOGIN', { selector: '#logout' }),
  ];
  return wrapModel(states, transitions);
}

function buildSuite(model: NavModel) {
  const suite = generateTraceSuite(model, { seed: 7, criteria: ['all-states', 'all-transitions'] });
  return mutateSuite(suite, model, { seed: 7, classifier: defaultFlowClassifier(model) });
}

// ---------------------------------------------------------------------------
// expandTemplate / urlTemplateToRegex
// ---------------------------------------------------------------------------

test('expandTemplate fills :param with the placeholder by default', () => {
  assert.equal(
    expandTemplate('/users/:id/orders/:oid'),
    `/users/${PARAM_PLACEHOLDER}/orders/${PARAM_PLACEHOLDER}`,
  );
});

test('expandTemplate uses supplied concrete param values', () => {
  assert.equal(expandTemplate('/users/:id', { id: '42' }), '/users/42');
});

test('expandTemplate maps undefined to empty string', () => {
  assert.equal(expandTemplate(undefined), '');
});

test('urlTemplateToRegex matches any :param segment', () => {
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(urlTemplateToRegex('/users/:id/edit'));
  assert.ok(re.test('/users/99/edit'));
  assert.ok(re.test('/users/abc/edit'));
  assert.ok(!re.test('/users/99/delete'));
});

test('isWriteEntry flags non-GET methods only', () => {
  assert.ok(isWriteEntry(sig('POST', '/x', '2xx')));
  assert.ok(isWriteEntry(sig('delete', '/x', '2xx')));
  assert.ok(!isWriteEntry(sig('GET', '/x', '2xx')));
});

// ---------------------------------------------------------------------------
// Compilation structure
// ---------------------------------------------------------------------------

test('every mutation variant compiles into a script with entry + aligned steps', () => {
  const model = flowModel();
  const mutation = buildSuite(model);
  assert.ok(mutation.mutations.length > 0, 'expected some mutation variants');
  const scripts = compileMutationSuite(mutation, model);
  assert.equal(scripts.length, mutation.mutations.length);

  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    const variant = mutation.mutations[i];
    // Entry navigation targets the variant's start URL.
    assert.equal(script.entry.source, 'entry');
    assert.equal(script.entry.action, 'browser_goto');
    assert.equal(script.entry.value, variant.startUrlTemplate);
    // Steps align 1:1 with the source steps by index.
    assert.equal(script.steps.length, variant.steps.length);
    script.steps.forEach((s, idx) => assert.equal(s.index, idx));
    // Provenance is carried through.
    assert.equal(script.provenance.traceId, variant.source.traceId);
    assert.equal(script.provenance.modelHash, variant.source.modelHash);
    assert.equal(script.wellFormed, variant.wellFormed);
    assert.equal(script.contractClass, variant.contract.class);
  }
});

test('model steps lower their recipe; synthetic steps lower their injected op', () => {
  const model = flowModel();
  const mutation = buildSuite(model);
  const scripts = compileMutationSuite(mutation, model);

  for (let i = 0; i < scripts.length; i++) {
    const variant = mutation.mutations[i];
    scripts[i].steps.forEach((cs, idx) => {
      const src = variant.steps[idx];
      if (src.kind === 'model') {
        assert.equal(cs.source, 'model');
        assert.equal(cs.action, src.transition.recipe.action);
        assert.equal(cs.selector, src.transition.recipe.selector);
        assert.equal(cs.intendedLandsOn, src.transition.to);
      } else {
        assert.equal(cs.source, 'synthetic');
        assert.equal(cs.action, src.action);
        assert.equal(cs.intendedLandsOn, src.landsOn);
      }
    });
  }
});

test('destination assertion uses the terminal state url template + predicates', () => {
  const model = flowModel();
  // A hand-built variant that ends on DONE (terminal, auth).
  const suite = generateTraceSuite(model, { seed: 3 });
  const mutation = mutateSuite(suite, model, { seed: 3, classifier: defaultFlowClassifier(model) });
  const revisit = mutation.mutations.find((m) => m.operator === 'revisit-after-terminal');
  assert.ok(revisit, 'expected a revisit-after-terminal variant');
  const script = compileMutatedTrace(revisit!, model);
  const urlA = script.assertions.find((a) => a.kind === 'url-template');
  assert.ok(urlA && urlA.kind === 'url-template');
  assert.equal(urlA.urlTemplate, '/confirmation');
  const predA = script.assertions.find((a) => a.kind === 'predicate');
  assert.ok(predA && predA.kind === 'predicate');
  assert.equal(predA.predicates.terminal, true);
});

test('contractRefs resolves url templates for states the contract references', () => {
  const model = flowModel();
  const mutation = buildSuite(model);
  const scripts = compileMutationSuite(mutation, model);
  const directEntry = scripts.find((s) => s.operator === 'direct-url-skip-prereqs');
  assert.ok(directEntry, 'expected a direct-url-skip-prereqs variant');
  // reject-or-redirect check references `target`; its url template must be baked in.
  const check = directEntry!.contract.check;
  assert.equal(check.kind, 'expect-reject-or-redirect');
  if (check.kind === 'expect-reject-or-redirect') {
    assert.ok(
      directEntry!.contractRefs.urlTemplates[check.target],
      'target url template should be resolved',
    );
  }
});

// ---------------------------------------------------------------------------
// Determinism — the core compilation contract
// ---------------------------------------------------------------------------

test('compilation is deterministic: identical inputs → byte-identical scripts', () => {
  const model = flowModel();
  const mutation = buildSuite(model);
  const a = compileMutationSuite(mutation, model);
  const b = compileMutationSuite(mutation, model);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('rendered Playwright source is deterministic and reflects the steps', () => {
  const model = flowModel();
  const mutation = buildSuite(model);
  const scripts = compileMutationSuite(mutation, model);
  for (const script of scripts) {
    const rendered = renderPlaywrightTest(script);
    assert.equal(rendered, script.playwright, 're-render must match the stored source');
    assert.ok(rendered.includes(`import { test, expect } from '@playwright/test';`));
    assert.ok(rendered.includes(`await page.goto(`), 'entry navigation should render a goto');
    assert.ok(rendered.includes('CONTRACT'), 'contract semantics should appear as comments');
  }
});

test('a cookie-clear variant destructures the context fixture and clears cookies', () => {
  const model = flowModel();
  const suite = generateTraceSuite(model, {
    seed: 11,
    criteria: ['all-states', 'all-transitions'],
  });
  const mutation = mutateSuite(suite, model, {
    seed: 11,
    classifier: defaultFlowClassifier(model),
  });
  const clear = mutation.mutations.find((m) => m.operator === 'session-clear-midflow');
  assert.ok(clear, 'expected a session-clear-midflow variant');
  const rendered = renderPlaywrightTest(compileMutatedTrace(clear!, model));
  assert.ok(rendered.includes('{ page, context }'), 'context fixture should be destructured');
  assert.ok(rendered.includes('await context.clearCookies();'));
});

test('back-nav variant renders page.goBack()', () => {
  const model = flowModel();
  const suite = generateTraceSuite(model, { seed: 5, criteria: ['all-states', 'all-transitions'] });
  const mutation = mutateSuite(suite, model, { seed: 5, classifier: defaultFlowClassifier(model) });
  const back = mutation.mutations.find((m) => m.operator === 'back-nav-after-auth-exit');
  if (back) {
    const rendered = renderPlaywrightTest(compileMutatedTrace(back, model));
    assert.ok(rendered.includes('await page.goBack();'));
  }
});

test('param placeholders in URLs are expanded deterministically and overridable', () => {
  const model = wrapModel(
    [state('A', '/a'), state('B', '/items/:id')],
    [edge('A', 'browser_goto', 'B', { selector: '#go' })],
  );
  const variant: MutatedTrace = {
    id: 't0~direct-url-skip-prereqs~0',
    operator: 'direct-url-skip-prereqs',
    seed: 1,
    source: { traceId: 't0', modelHash: 'h', specId: 'spec', targetKey: 'target' },
    startState: 'B',
    startUrlTemplate: '/items/:id',
    steps: [],
    contract: {
      class: 'reject-or-redirect-on-missing-prereq',
      outcome: 'reject',
      description: 'x',
      check: { kind: 'expect-reject-or-redirect', target: 'B', omittedPrerequisites: ['A|go|B'] },
    },
    wellFormed: false,
  };
  const dflt = compileMutatedTrace(variant, model);
  assert.equal(dflt.entry.value, `/items/${PARAM_PLACEHOLDER}`);
  const concrete = compileMutatedTrace(variant, model, { paramValues: { id: '77' } });
  assert.equal(concrete.entry.value, '/items/77');
});

test('a stale landsOn hint (state absent from model) skips destination assertions with a note', () => {
  const model = wrapModel([state('A', '/a')], []);
  const variant: MutatedTrace = {
    id: 't0~revisit-after-terminal~0',
    operator: 'revisit-after-terminal',
    seed: 1,
    source: { traceId: 't0', modelHash: 'h', specId: 'spec', targetKey: 'target' },
    startState: 'A',
    startUrlTemplate: '/a',
    steps: [
      {
        kind: 'synthetic',
        action: 'browser_goto',
        urlTemplate: '/gone',
        landsOn: 'GONE', // not a state in the model
        note: 'revisit a state the model no longer knows',
      },
    ],
    contract: {
      class: 'terminal-state-not-reprocessable',
      outcome: 'tolerate',
      description: 'x',
      check: { kind: 'expect-safe-revisit', target: 'GONE' },
    },
    wellFormed: true,
  };
  const script = compileMutatedTrace(variant, model);
  assert.equal(script.assertions.length, 0, 'no destination assertion for an unknown state');
  assert.equal(script.notes.length, 1);
  assert.ok(script.notes[0].includes('GONE'));
  assert.ok(script.playwright.includes('// note:'), 'the note surfaces in the rendered artifact');
});

test('rendered Playwright source is byte-identical across independent compiles', () => {
  const model = flowModel();
  const mutation = buildSuite(model);
  const a = compileMutationSuite(mutation, model);
  const b = compileMutationSuite(mutation, model);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(
      a[i].playwright,
      b[i].playwright,
      `variant ${a[i].variantId} render must be byte-identical`,
    );
  }
});
