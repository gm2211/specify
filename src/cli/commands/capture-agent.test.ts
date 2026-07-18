import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCommand, type AgentCommand } from './capture-agent.js';
import { canonicalProbeKey } from '../../monitor/predicates.js';
import type { ProbePlan } from '../../agent/probe-plan.js';

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
