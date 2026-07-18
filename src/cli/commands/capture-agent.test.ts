import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeCommand, type AgentCommand } from './capture-agent.js';
import { canonicalProbeKey } from '../../monitor/predicates.js';
import { buildProbePlan, type ProbePlan } from '../../agent/probe-plan.js';
import { ObservationRecorder } from '../../agent/observation.js';
import { buildVerifyTrace, mergeMonitorVerdicts } from '../../monitor/verdict-merge.js';
import { eventually, globally, pred } from '../../monitor/formula.js';
import {
  addDraft,
  emptyFormulasFile,
  hashDescription,
  loadFormulas,
  saveFormulas,
  setStatus,
  type FormulasFile,
} from '../../spec/formulas.js';

// Helper: minimal mock page
function mockPage(overrides: Record<string, (...args: any[]) => any> = {}) {
  return {
    url: () => 'https://example.com/login',
    goto: async () => {},
    click: async () => {},
    fill: async () => {},
    check: async () => {},
    uncheck: async () => {},
    hover: async () => {},
    press: async () => {},
    selectOption: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    waitForURL: async () => {},
    evaluate: async () => undefined,
    content: async () => '<html></html>',
    title: async () => 'Test Page',
    locator: () => ({ pressSequentially: async () => {} }),
    ...overrides,
  } as any;
}

test('executeCommand proxies click to page.click', async () => {
  const clicks: string[] = [];
  const page = mockPage({ click: async (s: string) => { clicks.push(s); } });

  const cmd: AgentCommand = { action: 'click', selector: 'button#submit' };
  const result = await executeCommand(page, cmd);

  assert.equal(result.success, true);
  assert.equal(result.action, 'click');
  assert.deepEqual(clicks, ['button#submit']);
});

test('executeCommand proxies fill to page.fill', async () => {
  const fills: Array<{ s: string; v: string }> = [];
  const page = mockPage({ fill: async (s: string, v: string) => { fills.push({ s, v }); } });

  const cmd: AgentCommand = { action: 'fill', selector: 'input#email', value: 'a@b.com' };
  const result = await executeCommand(page, cmd);

  assert.equal(result.success, true);
  assert.deepEqual(fills, [{ s: 'input#email', v: 'a@b.com' }]);
});

test('executeCommand proxies goto and auto-screenshots on navigation', async () => {
  let currentUrl = 'https://example.com/login';
  const screenshots: string[] = [];
  const page = mockPage({
    url: () => currentUrl,
    goto: async (url: string) => { currentUrl = url; },
  });
  const screenshotFn = async (name: string) => { screenshots.push(name); return `/tmp/${name}.png`; };

  const cmd: AgentCommand = { action: 'goto', url: 'https://example.com/dashboard' };
  const result = await executeCommand(page, cmd, screenshotFn);

  assert.equal(result.success, true);
  assert.equal(result.url, 'https://example.com/dashboard');
  assert.ok(result.screenshot, 'should have auto-screenshot on navigation');
  assert.equal(screenshots.length, 1);
  assert.ok(screenshots[0].startsWith('nav-'));
});

test('executeCommand auto-screenshots every mutating action (evidence capture)', async () => {
  const screenshots: string[] = [];
  const page = mockPage();
  const screenshotFn = async (name: string) => { screenshots.push(name); return `/tmp/${name}.png`; };

  const cmd: AgentCommand = { action: 'click', selector: '#btn' };
  await executeCommand(page, cmd, screenshotFn);

  // Mutation always produces a screenshot; the prefix differs by action when
  // the URL didn't change.
  assert.equal(screenshots.length, 1);
  assert.match(screenshots[0], /^click-/);
});

test('executeCommand returns done for done action', async () => {
  const page = mockPage();
  const result = await executeCommand(page, { action: 'done' });

  assert.equal(result.success, true);
  assert.equal(result.action, 'done');
});

test('executeCommand proxies evaluate and returns data', async () => {
  const page = mockPage({ evaluate: async () => 42 });

  const cmd: AgentCommand = { action: 'evaluate', expression: '1 + 1' };
  const result = await executeCommand(page, cmd);

  assert.equal(result.success, true);
  assert.equal(result.data, 42);
});

test('executeCommand proxies content and returns HTML', async () => {
  const page = mockPage({ content: async () => '<h1>Hello</h1>' });

  const result = await executeCommand(page, { action: 'content' });

  assert.equal(result.success, true);
  assert.equal(result.data, '<h1>Hello</h1>');
});

test('executeCommand proxies title', async () => {
  const page = mockPage({ title: async () => 'Login' });

  const result = await executeCommand(page, { action: 'title' });

  assert.equal(result.success, true);
  assert.equal(result.data, 'Login');
});

test('executeCommand returns error on failure without throwing', async () => {
  const page = mockPage({ click: async () => { throw new Error('Element not found'); } });

  const result = await executeCommand(page, { action: 'click', selector: '#nope' });

  assert.equal(result.success, false);
  assert.ok(result.error?.includes('Element not found'));
});

test('executeCommand proxies explicit screenshot via screenshotFn', async () => {
  const screenshots: string[] = [];
  const page = mockPage();
  const screenshotFn = async (name: string) => { screenshots.push(name); return `/tmp/${name}.png`; };

  const result = await executeCommand(page, { action: 'screenshot', name: 'after-login' }, screenshotFn);

  assert.equal(result.success, true);
  assert.deepEqual(screenshots, ['after-login']);
  assert.ok(result.screenshot);
});

function mockRecorder() {
  const calls: { begin: Array<{ action: string; args?: Record<string, unknown> }>; end: Array<{ success: boolean; error?: string; screenshot?: string }> } = { begin: [], end: [] };
  return {
    calls,
    beginStep: async (action: string, args?: Record<string, unknown>) => { calls.begin.push({ action, args }); },
    endStep: async (result: { success: boolean; error?: string; screenshot?: string }) => { calls.end.push(result); },
  } as any;
}

test('executeCommand records a step via the recorder on success', async () => {
  const page = mockPage();
  const recorder = mockRecorder();

  const result = await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder);

  assert.equal(result.success, true);
  assert.equal(recorder.calls.begin.length, 1);
  assert.deepEqual(recorder.calls.begin[0], { action: 'click', args: { selector: '#submit' } });
  assert.equal(recorder.calls.end.length, 1);
  assert.equal(recorder.calls.end[0].success, true);
});

test('executeCommand records a step via the recorder on failure, never a fill value', async () => {
  const page = mockPage({ fill: async () => { throw new Error('boom'); } });
  const recorder = mockRecorder();

  const result = await executeCommand(page, { action: 'fill', selector: '#password', value: 'super-secret' }, undefined, recorder);

  assert.equal(result.success, false);
  assert.equal(recorder.calls.begin.length, 1);
  // Only selector is recordable — the fill value must never reach the recorder.
  assert.deepEqual(recorder.calls.begin[0].args, { selector: '#password' });
  assert.equal(recorder.calls.end.length, 1);
  assert.equal(recorder.calls.end[0].success, false);
  assert.match(recorder.calls.end[0].error ?? '', /boom/);
});

test('executeCommand does not invoke the recorder for the done action', async () => {
  const page = mockPage();
  const recorder = mockRecorder();

  await executeCommand(page, { action: 'done' }, undefined, recorder);

  assert.equal(recorder.calls.begin.length, 0);
  assert.equal(recorder.calls.end.length, 0);
});

// ---------------------------------------------------------------------------
// Live dom.* probe sampling (SP-efp)
// ---------------------------------------------------------------------------

function mockRecorderWithEnd() {
  const ends: Array<{ success: boolean; error?: string; screenshot?: string; probes?: Record<string, boolean>; probesTruncated?: boolean }> = [];
  return {
    ends,
    beginStep: async () => {},
    endStep: async (result: any) => { ends.push(result); },
  } as any;
}

/** Builds a page whose `locator(selector)` returns a stubbed locator for a fixed selector -> behavior map. */
function mockPageWithLocators(
  behaviors: Record<string, { count?: number; visible?: boolean; text?: string | null; delayMs?: number; throws?: boolean }>,
) {
  return mockPage({
    locator: (selector: string) => {
      const b = behaviors[selector] ?? {};
      const maybeDelay = async <T>(value: T): Promise<T> => {
        if (b.throws) throw new Error(`probe failure for ${selector}`);
        if (b.delayMs) await new Promise((resolve) => setTimeout(resolve, b.delayMs));
        return value;
      };
      const locatorObj: any = {
        count: async () => maybeDelay(b.count ?? 0),
        isVisible: async () => maybeDelay(b.visible ?? false),
        textContent: async () => maybeDelay(b.text ?? null),
        first: () => locatorObj,
      };
      return locatorObj;
    },
  });
}

test('executeCommand samples dom.exists/dom.visible/dom.text/dom.count probes and records them on the step', async () => {
  const page = mockPageWithLocators({
    '#toast': { count: 1, visible: true, text: 'Order placed' },
    '.cart-item': { count: 3 },
  });
  const recorder = mockRecorderWithEnd();
  const probePlan: ProbePlan = [
    { key: canonicalProbeKey('dom.exists', ['#toast']), predicate: 'dom.exists', args: ['#toast'] },
    { key: canonicalProbeKey('dom.visible', ['#toast']), predicate: 'dom.visible', args: ['#toast'] },
    { key: canonicalProbeKey('dom.text', ['#toast', 'placed']), predicate: 'dom.text', args: ['#toast', 'placed'] },
    { key: canonicalProbeKey('dom.count', ['.cart-item', 'gte', '2']), predicate: 'dom.count', args: ['.cart-item', 'gte', '2'] },
  ];

  await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder, probePlan);

  assert.equal(recorder.ends.length, 1);
  const probes = recorder.ends[0].probes;
  assert.ok(probes);
  assert.equal(probes![canonicalProbeKey('dom.exists', ['#toast'])], true);
  assert.equal(probes![canonicalProbeKey('dom.visible', ['#toast'])], true);
  assert.equal(probes![canonicalProbeKey('dom.text', ['#toast', 'placed'])], true);
  assert.equal(probes![canonicalProbeKey('dom.count', ['.cart-item', 'gte', '2'])], true);
  assert.equal(recorder.ends[0].probesTruncated, false);
});

test('executeCommand omits a probe key on error instead of recording false', async () => {
  const page = mockPageWithLocators({ '#missing': { throws: true } });
  const recorder = mockRecorderWithEnd();
  const probePlan: ProbePlan = [
    { key: canonicalProbeKey('dom.exists', ['#missing']), predicate: 'dom.exists', args: ['#missing'] },
  ];

  await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder, probePlan);

  const probes = recorder.ends[0].probes;
  assert.deepEqual(probes, {});
});

test('executeCommand omits a probe key on timeout instead of recording false', async () => {
  const page = mockPageWithLocators({ '#slow': { count: 1, delayMs: 800 } });
  const recorder = mockRecorderWithEnd();
  const probePlan: ProbePlan = [
    { key: canonicalProbeKey('dom.exists', ['#slow']), predicate: 'dom.exists', args: ['#slow'] },
  ];

  await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder, probePlan);

  const probes = recorder.ends[0].probes;
  assert.deepEqual(probes, {});
});

test('executeCommand does not sample probes when no probePlan is given (zero behavior change)', async () => {
  const page = mockPageWithLocators({});
  const recorder = mockRecorderWithEnd();

  await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder);

  assert.equal(recorder.ends.length, 1);
  assert.equal(recorder.ends[0].probes, undefined);
});

test('executeCommand does not sample probes when probePlan is empty', async () => {
  const page = mockPageWithLocators({});
  const recorder = mockRecorderWithEnd();

  await executeCommand(page, { action: 'click', selector: '#submit' }, undefined, recorder, []);

  assert.equal(recorder.ends[0].probes, undefined);
});

test('executeCommand samples probes on the failure path too', async () => {
  const page = mockPageWithLocators({ '#toast': { count: 1 } });
  page.click = async () => { throw new Error('boom'); };
  const recorder = mockRecorderWithEnd();
  const probePlan: ProbePlan = [
    { key: canonicalProbeKey('dom.exists', ['#toast']), predicate: 'dom.exists', args: ['#toast'] },
  ];

  const result = await executeCommand(page, { action: 'click', selector: '#nope' }, undefined, recorder, probePlan);

  assert.equal(result.success, false);
  assert.equal(recorder.ends[0].success, false);
  assert.equal(recorder.ends[0].probes?.[canonicalProbeKey('dom.exists', ['#toast'])], true);
});

// ---------------------------------------------------------------------------
// End-to-end key consistency (SP-efp)
// ---------------------------------------------------------------------------
//
// The linchpin of the whole probe mechanism is that canonicalProbeKey is
// computed identically on BOTH sides of the pipeline: the extraction side
// (probe-plan.ts keys the ProbePlan from formula AST nodes) and the lookup
// side (predicates.ts's dom.* evalFns re-derive the key from the formula's
// predicate name + args at evaluation time). The component tests above and
// in probe-plan.test.ts / predicates.test.ts each pin one side; this test
// pins the SEAM by driving the full pipeline from an actual on-disk formulas
// file: loadFormulas -> buildProbePlan -> executeCommand's live sampling
// (stubbed page, real ObservationRecorder) -> buildVerifyTrace ->
// mergeMonitorVerdicts, asserting the deterministic verdicts come out the
// other end. If either side's keying ever silently diverged, every probe
// would evaluate 'unevaluable' and these satisfied/violated assertions
// would fail.

const E2E_PROVENANCE = { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' };

function e2eAddFormula(
  file: FormulasFile,
  behavior: string,
  formula: Parameters<typeof addDraft>[1]['formula'],
  status: 'draft' | 'approved',
): FormulasFile {
  const { file: withDraft, entry } = addDraft(file, {
    behavior,
    formula,
    description_hash: hashDescription(behavior),
    predicates_used: [],
    provenance: E2E_PROVENANCE,
  });
  return status === 'draft' ? withDraft : setStatus(withDraft, entry.id, status);
}

test('SP-efp end-to-end: formulas file -> probe plan -> live sampling -> recorded steps -> deterministic monitor verdicts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
  try {
    // 1. An ACTUAL formulas file on disk, round-tripped through save/load.
    //    Covers: single-arg predicate (dom.visible — the arg list is shorter
    //    than dom.count's, exercising canonicalProbeKey's skip-undefined-args
    //    path), a numeric-arg predicate (dom.count), and a draft entry
    //    (dom.exists) to prove drafts are sampled for shadow mode.
    let file = emptyFormulasFile();
    file = e2eAddFormula(file, 'ui/toast-appears', eventually(pred('dom.visible', ['#toast'])), 'approved');
    file = e2eAddFormula(file, 'ui/cart-filled', globally(pred('dom.count', ['.cart-item', 'gte', '2'])), 'approved');
    file = e2eAddFormula(file, 'ui/banner-shown', eventually(pred('dom.exists', ['#banner'])), 'draft');
    const formulasPath = path.join(dir, 'specify.formulas.yaml');
    saveFormulas(formulasPath, file);
    const loaded = loadFormulas(formulasPath);
    assert.ok(loaded);

    // 2. Extraction side: plan from the loaded file.
    const plan = buildProbePlan(loaded!);
    assert.equal(plan.length, 3); // dedupe fine, drafts included

    // 3. Live sampling side: stubbed page, REAL ObservationRecorder (the
    //    exact recorder executeCommand drives in production).
    const page = mockPageWithLocators({
      '#toast': { visible: true },
      '.cart-item': { count: 1 }, // fails gte 2 -> violated
      '#banner': { count: 1 },
      body: {},
    });
    // ObservationRecorder.captureAx uses locator('body').ariaSnapshot.
    const baseLocator = page.locator;
    page.locator = (selector: string) => {
      const loc = baseLocator(selector);
      loc.ariaSnapshot = async () => '- generic';
      return loc;
    };
    const recorder = new ObservationRecorder({
      outputDir: dir,
      page,
      collector: { getTraffic: () => [], getConsoleLogs: () => [] },
    });

    await executeCommand(page, { action: 'goto', url: 'https://x.test/' }, undefined, recorder, plan);
    await executeCommand(page, { action: 'click', selector: '#add-to-cart' }, undefined, recorder, plan);

    const steps = recorder.getSteps();
    assert.equal(steps.length, 2);
    // Sanity: probes actually landed on the recorded steps under plan keys.
    assert.equal(steps[0].probes?.[canonicalProbeKey('dom.visible', ['#toast'])], true);
    assert.equal(steps[0].probes?.[canonicalProbeKey('dom.count', ['.cart-item', 'gte', '2'])], false);

    // 4. Lookup side: trace + merge, verdicts re-derive the keys from the
    //    formula ASTs independently of the plan.
    const trace = buildVerifyTrace(steps, [], []);
    const output = {
      pass: true,
      summary: { total: 3, passed: 3, failed: 0, skipped: 0 },
      results: [
        { id: 'ui/toast-appears', description: 'toast', status: 'passed' as const },
        { id: 'ui/cart-filled', description: 'cart', status: 'passed' as const },
        { id: 'ui/banner-shown', description: 'banner', status: 'passed' as const },
      ],
    };
    const merged = mergeMonitorVerdicts(output, loaded!, trace);
    const results = (merged.output as typeof output).results as Array<
      (typeof output)['results'][number] & { verdict_source?: string; monitor?: Array<{ verdict: string; status: string }> }
    >;
    const byId = new Map(results.map((r) => [r.id, r]));

    // F(dom.visible(#toast)) approved, probe true -> satisfied, corroborates the pass.
    assert.equal(byId.get('ui/toast-appears')?.monitor?.[0].verdict, 'satisfied');
    assert.equal(byId.get('ui/toast-appears')?.status, 'passed');
    assert.equal(byId.get('ui/toast-appears')?.verdict_source, 'monitor+llm');

    // G(dom.count(.cart-item, gte, 2)) approved, probe false -> violated, monitor forces failed.
    assert.equal(byId.get('ui/cart-filled')?.monitor?.[0].verdict, 'violated');
    assert.equal(byId.get('ui/cart-filled')?.status, 'failed');
    assert.equal(byId.get('ui/cart-filled')?.verdict_source, 'monitor');
    assert.deepEqual(merged.monitorForcedFailures, ['ui/cart-filled']);

    // F(dom.exists(#banner)) draft, probe true -> satisfied, advisory only (shadow mode).
    assert.equal(byId.get('ui/banner-shown')?.monitor?.[0].verdict, 'satisfied');
    assert.equal(byId.get('ui/banner-shown')?.monitor?.[0].status, 'draft');
    assert.equal(byId.get('ui/banner-shown')?.status, 'passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
