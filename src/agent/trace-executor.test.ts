import assert from 'node:assert/strict';
import test from 'node:test';
import type { NetworkSignatureEntry } from '../model/nav-model.js';
import type { Contract } from '../model/mutators.js';
import type { CompiledScript, CompiledStep, ContractRefs } from '../model/trace-compiler.js';
import {
  evaluateContract,
  executeVariant,
  executeCompiledSuite,
  summarizeExecution,
  renderExecutionSummary,
  matchesTemplate,
  type CapturedTrace,
  type CapturedStep,
  type StepDriver,
  type AgentFallback,
  type AgentFallbackOutcome,
} from './trace-executor.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function sig(
  method: string,
  urlTemplate: string,
  statusClass: NetworkSignatureEntry['statusClass'],
): NetworkSignatureEntry {
  return { method, urlTemplate, statusClass };
}

function cap(index: number, over: Partial<CapturedStep> = {}): CapturedStep {
  return { index, action: 'browser_click', outcome: 'ok', ...over };
}

function capturedTrace(steps: CapturedStep[], over: Partial<CapturedTrace> = {}): CapturedTrace {
  return { entry: cap(-1, { action: 'browser_goto' }), steps, ...over };
}

function compiledStep(index: number, over: Partial<CompiledStep> = {}): CompiledStep {
  return {
    index,
    source: index < 0 ? 'entry' : 'model',
    action: index < 0 ? 'browser_goto' : 'browser_click',
    ...over,
  };
}

function script(
  contract: Contract,
  refs: ContractRefs,
  steps: CompiledStep[] = [],
): CompiledScript {
  return {
    version: 1,
    variantId: 't0~double-submit~0',
    operator: 'double-submit',
    contractClass: contract.class,
    provenance: { seed: 1, traceId: 't0', modelHash: 'h', specId: 'spec', targetKey: 'target' },
    entry: compiledStep(-1, { action: 'browser_goto', value: '/start' }),
    steps,
    assertions: [],
    contract,
    contractRefs: refs,
    wellFormed: contract.outcome === 'tolerate',
    playwright: '',
  };
}

/** A driver that replays a pre-programmed capture per step index. */
function replayDriver(entry: CapturedStep, byIndex: Map<number, CapturedStep>): StepDriver {
  return {
    async runStep(step) {
      if (step.index < 0) return entry;
      const c = byIndex.get(step.index);
      if (!c) return cap(step.index, { action: step.action });
      return c;
    },
  };
}

const noFallback: AgentFallback = {
  async runTrace() {
    throw new Error('fallback should not be called');
  },
};

// ---------------------------------------------------------------------------
// matchesTemplate
// ---------------------------------------------------------------------------

test('matchesTemplate: literal + param segments', () => {
  assert.ok(matchesTemplate('http://x/checkout', '/checkout'));
  assert.ok(matchesTemplate('http://x/users/5/edit', '/users/:id/edit'));
  assert.ok(!matchesTemplate('http://x/users/5', '/users/:id/edit'));
  assert.ok(!matchesTemplate('http://x/login', '/checkout'));
});

// ---------------------------------------------------------------------------
// Contract matrix: no-repeated-write
// ---------------------------------------------------------------------------

const dsContract = (): Contract => ({
  class: 'no-second-side-effect',
  outcome: 'tolerate',
  description: 'x',
  check: {
    kind: 'no-repeated-write',
    injectedStepIndex: 1,
    write: [sig('POST', '/pay', '2xx')],
    onRepeatedSuccess: 'inconclusive',
  },
});

test('no-repeated-write: rejected second fire (4xx) → pass', () => {
  const ct = capturedTrace([cap(0), cap(1, { network: [sig('POST', '/pay', '4xx')] })]);
  const e = evaluateContract(dsContract(), ct, { urlTemplates: {} });
  assert.equal(e.verdict, 'pass');
});

test('no-repeated-write: no matching write on re-fire → pass (no second side effect)', () => {
  const ct = capturedTrace([cap(0), cap(1, { network: [] })]);
  assert.equal(evaluateContract(dsContract(), ct, { urlTemplates: {} }).verdict, 'pass');
});

test('no-repeated-write: repeated 2xx with no corroboration → inconclusive', () => {
  const ct = capturedTrace([cap(0), cap(1, { network: [sig('POST', '/pay', '2xx')] })]);
  assert.equal(evaluateContract(dsContract(), ct, { urlTemplates: {} }).verdict, 'inconclusive');
});

test('no-repeated-write: repeated 2xx WITH corroboration → violation', () => {
  const ct = capturedTrace([cap(0), cap(1, { network: [sig('POST', '/pay', '2xx')] })], {
    duplicationCorroborated: true,
  });
  const e = evaluateContract(dsContract(), ct, { urlTemplates: {} });
  assert.equal(e.verdict, 'violation');
  assert.ok(e.evidence[0].includes('corroborated'));
});

test('no-repeated-write: re-fire step did not execute → inconclusive', () => {
  const ct = capturedTrace([cap(0), cap(1, { outcome: 'grounding-failure', reason: 'gone' })]);
  assert.equal(evaluateContract(dsContract(), ct, { urlTemplates: {} }).verdict, 'inconclusive');
});

// ---------------------------------------------------------------------------
// Contract matrix: expect-auth-redirect
// ---------------------------------------------------------------------------

const authContract = (): Contract => ({
  class: 'redirect-to-login-on-auth-loss',
  outcome: 'reject',
  description: 'x',
  check: { kind: 'expect-auth-redirect', fromStepIndex: 1, authStates: ['DASH'] },
});
const authRefs: ContractRefs = { urlTemplates: { DASH: '/dashboard' } };

test('expect-auth-redirect: re-rendered auth content → violation', () => {
  const ct = capturedTrace([
    cap(0),
    cap(1, {
      intendedLandsOn: 'DASH',
      predicates: { authenticated: true },
      network: [sig('GET', '/dashboard', '2xx')],
    }),
  ]);
  assert.equal(evaluateContract(authContract(), ct, authRefs).verdict, 'violation');
});

test('expect-auth-redirect: redirect (3xx) on the auth-targeting step → pass', () => {
  const ct = capturedTrace([
    cap(0),
    cap(1, { intendedLandsOn: 'DASH', network: [sig('GET', '/dashboard', '3xx')] }),
  ]);
  assert.equal(evaluateContract(authContract(), ct, authRefs).verdict, 'pass');
});

test('expect-auth-redirect: landed on non-auth page → pass', () => {
  const ct = capturedTrace([
    cap(0),
    cap(1, { intendedLandsOn: 'DASH', predicates: { authenticated: false } }),
  ]);
  assert.equal(evaluateContract(authContract(), ct, authRefs).verdict, 'pass');
});

test('expect-auth-redirect: no auth-targeting step reached → inconclusive', () => {
  const ct = capturedTrace([cap(0), cap(1, { intendedLandsOn: 'OTHER' })]);
  assert.equal(evaluateContract(authContract(), ct, authRefs).verdict, 'inconclusive');
});

// ---------------------------------------------------------------------------
// Contract matrix: expect-reject-or-redirect
// ---------------------------------------------------------------------------

const rejectContract = (): Contract => ({
  class: 'reject-or-redirect-on-missing-prereq',
  outcome: 'reject',
  description: 'x',
  check: {
    kind: 'expect-reject-or-redirect',
    target: 'CHECKOUT',
    omittedPrerequisites: ['a', 'b'],
  },
});
const rejectRefs: ContractRefs = { urlTemplates: { CHECKOUT: '/checkout' } };

test('expect-reject-or-redirect: entry redirected (3xx) → pass', () => {
  const ct = capturedTrace([], {
    entry: cap(-1, { action: 'browser_goto', network: [sig('GET', '/checkout', '3xx')] }),
  });
  assert.equal(evaluateContract(rejectContract(), ct, rejectRefs).verdict, 'pass');
});

test('expect-reject-or-redirect: entry rejected (4xx) → pass', () => {
  const ct = capturedTrace([], {
    entry: cap(-1, { action: 'browser_goto', network: [sig('GET', '/checkout', '4xx')] }),
  });
  assert.equal(evaluateContract(rejectContract(), ct, rejectRefs).verdict, 'pass');
});

test('expect-reject-or-redirect: landed on target with no gate → violation', () => {
  const ct = capturedTrace([], {
    entry: cap(-1, {
      action: 'browser_goto',
      url: 'http://x/checkout',
      network: [sig('GET', '/checkout', '2xx')],
    }),
  });
  assert.equal(evaluateContract(rejectContract(), ct, rejectRefs).verdict, 'violation');
});

test('expect-reject-or-redirect: landed elsewhere → pass (redirected away)', () => {
  const ct = capturedTrace([], {
    entry: cap(-1, {
      action: 'browser_goto',
      url: 'http://x/login',
      network: [sig('GET', '/login', '2xx')],
    }),
  });
  assert.equal(evaluateContract(rejectContract(), ct, rejectRefs).verdict, 'pass');
});

// ---------------------------------------------------------------------------
// Contract matrix: expect-safe-revisit
// ---------------------------------------------------------------------------

const revisitContract = (): Contract => ({
  class: 'terminal-state-not-reprocessable',
  outcome: 'tolerate',
  description: 'x',
  check: { kind: 'expect-safe-revisit', target: 'DONE' },
});

test('expect-safe-revisit: no write on revisit → pass', () => {
  const ct = capturedTrace([
    cap(0, {
      intendedLandsOn: 'DONE',
      action: 'browser_goto',
      network: [sig('GET', '/confirmation', '2xx')],
    }),
  ]);
  assert.equal(evaluateContract(revisitContract(), ct, { urlTemplates: {} }).verdict, 'pass');
});

test('expect-safe-revisit: a write fires on revisit → violation', () => {
  const ct = capturedTrace([
    cap(0, {
      intendedLandsOn: 'DONE',
      action: 'browser_goto',
      network: [sig('POST', '/orders', '2xx')],
    }),
  ]);
  assert.equal(evaluateContract(revisitContract(), ct, { urlTemplates: {} }).verdict, 'violation');
});

test('expect-safe-revisit: revisit did not execute → inconclusive', () => {
  const ct = capturedTrace([
    cap(0, { intendedLandsOn: 'DONE', outcome: 'grounding-failure', reason: 'gone' }),
  ]);
  assert.equal(
    evaluateContract(revisitContract(), ct, { urlTemplates: {} }).verdict,
    'inconclusive',
  );
});

// ---------------------------------------------------------------------------
// executeVariant: scripted-first, grounding gap, agent fallback
// ---------------------------------------------------------------------------

test('executeVariant: green scripted run evaluates the contract', async () => {
  const s = script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]);
  const driver = replayDriver(
    cap(-1, { action: 'browser_goto' }),
    new Map([
      [0, cap(0)],
      [1, cap(1, { network: [sig('POST', '/pay', '4xx')] })],
    ]),
  );
  const r = await executeVariant(s, driver, noFallback);
  assert.equal(r.tier, 'scripted');
  assert.equal(r.category, 'assertion');
  assert.equal(r.verdict, 'pass');
});

test('executeVariant: scripted drift + agent re-grounds → assertion via agent signals', async () => {
  const s = script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]);
  // Step 1 drifts under scripted execution.
  const driver = replayDriver(
    cap(-1, { action: 'browser_goto' }),
    new Map([
      [0, cap(0)],
      [1, cap(1, { outcome: 'grounding-failure', reason: 'selector #pay gone' })],
    ]),
  );
  const fallback: AgentFallback = {
    async runTrace(): Promise<AgentFallbackOutcome> {
      return {
        grounded: true,
        reRecorded: { stepIndex: 1, note: 'new selector button[data-pay]' },
        captured: capturedTrace([cap(0), cap(1, { network: [sig('POST', '/pay', '4xx')] })]),
      };
    },
  };
  const r = await executeVariant(s, driver, fallback);
  assert.equal(r.tier, 'agent-fallback');
  assert.equal(r.category, 'assertion');
  assert.equal(r.verdict, 'pass');
  assert.ok(r.reRecorded);
  assert.ok(r.evidence.some((e) => e.includes('drifted')));
});

test('executeVariant: scripted drift + agent also fails → grounding gap, NOT an app bug', async () => {
  const s = script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]);
  const driver = replayDriver(
    cap(-1, { action: 'browser_goto' }),
    new Map([
      [0, cap(0)],
      [1, cap(1, { outcome: 'grounding-failure', reason: 'state drifted' })],
    ]),
  );
  const fallback: AgentFallback = {
    async runTrace(): Promise<AgentFallbackOutcome> {
      return { grounded: false, reason: 'agent could not locate the pay control' };
    },
  };
  const r = await executeVariant(s, driver, fallback);
  assert.equal(r.category, 'grounding-gap');
  assert.equal(r.verdict, undefined);
  assert.equal(r.groundingGap?.failedStepIndex, 1);
  assert.ok(r.evidence.some((e) => e.includes('NOT an app bug')));
});

test('executeVariant: grounding failure on entry navigation triggers fallback', async () => {
  const s = script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]);
  const driver = replayDriver(
    cap(-1, { action: 'browser_goto', outcome: 'grounding-failure', reason: 'nav failed' }),
    new Map(),
  );
  let calledWith = -99;
  const fallback: AgentFallback = {
    async runTrace(_script, failedStepIndex): Promise<AgentFallbackOutcome> {
      calledWith = failedStepIndex;
      return { grounded: false, reason: 'entry unreachable' };
    },
  };
  const r = await executeVariant(s, driver, fallback);
  assert.equal(calledWith, -1);
  assert.equal(r.category, 'grounding-gap');
});

test('executeVariant: a throwing driver is inconclusive, never a violation', async () => {
  const s = script(dsContract(), { urlTemplates: {} }, [compiledStep(0)]);
  const driver: StepDriver = {
    async runStep() {
      throw new Error('boom');
    },
  };
  const r = await executeVariant(s, driver, noFallback);
  assert.equal(r.category, 'assertion');
  assert.equal(r.verdict, 'inconclusive');
});

// ---------------------------------------------------------------------------
// Suite-level summary
// ---------------------------------------------------------------------------

test('executeCompiledSuite + summary aggregates verdicts and gaps', async () => {
  const pass = script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]);
  const driverPass = replayDriver(
    cap(-1, { action: 'browser_goto' }),
    new Map([[1, cap(1, { network: [sig('POST', '/pay', '4xx')] })]]),
  );

  const gap = script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]);
  const driverGap = replayDriver(
    cap(-1, { action: 'browser_goto' }),
    new Map([[1, cap(1, { outcome: 'grounding-failure', reason: 'x' })]]),
  );
  const failFallback: AgentFallback = {
    async runTrace() {
      return { grounded: false, reason: 'nope' };
    },
  };

  const results = [
    await executeVariant(pass, driverPass, noFallback),
    await executeVariant(gap, driverGap, failFallback),
  ];
  const summary = summarizeExecution(results);
  assert.equal(summary.total, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.groundingGaps, 1);
  assert.equal(summary.agentFallbacks, 1);
  assert.ok(renderExecutionSummary(results).includes('grounding-gap'));
});

test('executeCompiledSuite preserves order', async () => {
  const driver = replayDriver(
    cap(-1, { action: 'browser_goto' }),
    new Map([[1, cap(1, { network: [sig('POST', '/pay', '4xx')] })]]),
  );
  const scripts = [
    {
      ...script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]),
      variantId: 'a',
    },
    {
      ...script(dsContract(), { urlTemplates: {} }, [compiledStep(0), compiledStep(1)]),
      variantId: 'b',
    },
  ];
  const results = await executeCompiledSuite(scripts, driver, noFallback);
  assert.deepEqual(
    results.map((r) => r.variantId),
    ['a', 'b'],
  );
});
