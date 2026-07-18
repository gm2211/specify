/**
 * src/cli/commands/capture-agent.ts — Playwright command execution
 *
 * Provides executeCommand() which proxies Playwright page actions and handles
 * auto-screenshots on navigation. Used by the browser MCP server.
 */

import type { Page } from 'playwright';
import type { ObservationRecorder } from '../../agent/observation.js';
import type { ProbePlan, ProbeSpec } from '../../agent/probe-plan.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentCommand =
  | { action: 'goto'; url: string; options?: { waitUntil?: string; timeout?: number } }
  | { action: 'click'; selector: string; options?: { timeout?: number } }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'type'; selector: string; text: string; options?: { delay?: number } }
  | { action: 'selectOption'; selector: string; value: string | string[] }
  | { action: 'check'; selector: string }
  | { action: 'uncheck'; selector: string }
  | { action: 'hover'; selector: string }
  | { action: 'press'; selector: string; key: string }
  | { action: 'waitForSelector'; selector: string; options?: { state?: string; timeout?: number } }
  | { action: 'waitForTimeout'; ms: number }
  | { action: 'waitForURL'; url: string; options?: { timeout?: number } }
  | { action: 'evaluate'; expression: string }
  | { action: 'screenshot'; name?: string }
  | { action: 'content' }
  | { action: 'url' }
  | { action: 'title' }
  | { action: 'done' };

export interface CommandResult {
  type: 'result';
  action: string;
  success: boolean;
  url: string;
  screenshot?: string;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Execute a single Playwright command
// ---------------------------------------------------------------------------

export async function executeCommand(
  page: Page,
  cmd: AgentCommand,
  screenshotFn?: (name: string) => Promise<string>,
  recorder?: ObservationRecorder,
  probePlan?: ProbePlan,
): Promise<CommandResult> {
  if (cmd.action === 'done') {
    return { type: 'result', action: 'done', success: true, url: page.url() };
  }

  if (recorder) {
    const args: Record<string, unknown> = {};
    if ('selector' in cmd) args.selector = cmd.selector;
    if ('url' in cmd) args.url = cmd.url;
    await recorder.beginStep(cmd.action, args);
  }

  try {
    let data: unknown = undefined;
    let screenshot: string | undefined;
    const urlBefore = page.url();

    switch (cmd.action) {
      case 'goto':
        await page.goto(cmd.url, {
          waitUntil: (cmd.options?.waitUntil as 'domcontentloaded') ?? 'domcontentloaded',
          timeout: cmd.options?.timeout ?? 15_000,
        });
        break;

      case 'click':
        await page.click(cmd.selector, { timeout: cmd.options?.timeout });
        await page.waitForTimeout(300);
        break;

      case 'fill':
        await page.fill(cmd.selector, cmd.value);
        break;

      case 'type':
        await page.locator(cmd.selector).pressSequentially(cmd.text, { delay: cmd.options?.delay ?? 50 });
        break;

      case 'selectOption':
        await page.selectOption(cmd.selector, cmd.value);
        break;

      case 'check':
        await page.check(cmd.selector);
        break;

      case 'uncheck':
        await page.uncheck(cmd.selector);
        break;

      case 'hover':
        await page.hover(cmd.selector);
        break;

      case 'press':
        await page.press(cmd.selector, cmd.key);
        break;

      case 'waitForSelector':
        await page.waitForSelector(cmd.selector, {
          state: (cmd.options?.state as 'visible') ?? 'visible',
          timeout: cmd.options?.timeout ?? 10_000,
        });
        break;

      case 'waitForTimeout':
        await page.waitForTimeout(cmd.ms);
        break;

      case 'waitForURL':
        await page.waitForURL(cmd.url, { timeout: cmd.options?.timeout ?? 10_000 });
        break;

      case 'evaluate':
        data = await page.evaluate(cmd.expression);
        break;

      case 'screenshot':
        if (screenshotFn) {
          screenshot = await screenshotFn(cmd.name ?? 'agent-manual');
        }
        break;

      case 'content':
        data = await page.content();
        break;

      case 'url':
        data = page.url();
        break;

      case 'title':
        data = await page.title();
        break;
    }

    // Auto-screenshot after every mutating action (deterministic evidence capture)
    const MUTATING_ACTIONS = new Set(['goto', 'click', 'fill', 'type', 'selectOption', 'check', 'uncheck', 'hover', 'press']);
    const urlAfter = page.url();
    if (screenshotFn && cmd.action !== 'screenshot' && MUTATING_ACTIONS.has(cmd.action)) {
      const label = urlBefore !== urlAfter
        ? `nav-${slugifyUrl(urlAfter)}`
        : `${cmd.action}-${'selector' in cmd ? slugifyUrl(cmd.selector) : slugifyUrl(urlAfter)}`;
      screenshot = await screenshotFn(label);
    }

    if (recorder) {
      const sampled = probePlan && probePlan.length > 0 ? await sampleProbes(page, probePlan) : undefined;
      await recorder.endStep({
        success: true,
        screenshot,
        ...(sampled ? { probes: sampled.probes, probesTruncated: sampled.truncated } : {}),
      });
    }

    return {
      type: 'result',
      action: cmd.action,
      success: true,
      url: urlAfter,
      ...(screenshot ? { screenshot } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (recorder) {
      const sampled = probePlan && probePlan.length > 0 ? await sampleProbes(page, probePlan) : undefined;
      await recorder.endStep({
        success: false,
        error: errorMessage,
        ...(sampled ? { probes: sampled.probes, probesTruncated: sampled.truncated } : {}),
      });
    }

    return {
      type: 'result',
      action: cmd.action,
      success: false,
      url: page.url(),
      error: errorMessage,
    };
  }
}

function slugifyUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '').replace(/[/?&#=.]/g, '_').replace(/_+/g, '_').replace(/_$/, '').substring(0, 60) || 'root';
  } catch {
    return 'page';
  }
}

// ---------------------------------------------------------------------------
// Live dom.* probe sampling (SP-efp)
// ---------------------------------------------------------------------------
//
// Same hook point as the AX snapshot (recorder.endStep): after every action,
// each dom.* predicate named by an approved/draft formula (see
// src/agent/probe-plan.ts) is evaluated live against the current page and
// its boolean result is recorded onto the step. A probe that errors or times
// out is simply OMITTED from the result map — never a thrown error, never a
// recorded `false` — so predicates.ts's dom.* evalFns correctly read it as
// 'unevaluable' downstream, exactly mirroring every other predicate's
// three-outcome contract.

/** Per-probe timeout (ms). A single slow/hung locator must not stall the whole step. */
const PROBE_TIMEOUT_MS = 500;
/** Total probe budget per step (ms). Once exceeded, remaining planned probes are skipped for this step. */
const PROBE_BUDGET_MS = 2000;

/** Race `promise` against a timeout; rejects if `ms` elapses first. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Evaluate one ProbeSpec live against `page`. Throws on any failure (unknown selector, bad op, page closed, ...) — caller catches and omits the key. */
async function evalProbe(page: Page, spec: ProbeSpec): Promise<boolean> {
  const [selector, arg2, arg3] = spec.args;
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new Error(`probe ${spec.predicate} missing selector`);
  }

  switch (spec.predicate) {
    case 'dom.exists': {
      const count = await page.locator(selector).count();
      return count > 0;
    }
    case 'dom.visible': {
      return await page.locator(selector).first().isVisible();
    }
    case 'dom.text': {
      if (typeof arg2 !== 'string') throw new Error('dom.text requires a regex arg');
      // eslint-disable-next-line security/detect-non-literal-regexp
      const re = new RegExp(arg2);
      const text = await page.locator(selector).first().textContent();
      return text !== null && re.test(text);
    }
    case 'dom.count': {
      const n = Number(arg3);
      if (!Number.isFinite(n)) throw new Error(`dom.count has non-numeric n: ${String(arg3)}`);
      const count = await page.locator(selector).count();
      switch (arg2) {
        case 'eq':
          return count === n;
        case 'gte':
          return count >= n;
        case 'lte':
          return count <= n;
        case 'gt':
          return count > n;
        case 'lt':
          return count < n;
        default:
          throw new Error(`dom.count has unknown op: ${String(arg2)}`);
      }
    }
    default:
      throw new Error(`unknown live probe predicate: ${spec.predicate}`);
  }
}

/**
 * Sample every probe in `plan` against the current page, bounded by
 * PROBE_BUDGET_MS total. A probe that errors or times out (PROBE_TIMEOUT_MS)
 * is omitted from `probes` (never a thrown error, never a recorded `false`).
 * If the overall budget is exceeded, any remaining un-sampled probes are
 * simply skipped and `truncated` is set — recorded onto the step so it's
 * visible in observations.json, not silently dropped.
 */
async function sampleProbes(page: Page, plan: ProbePlan): Promise<{ probes: Record<string, boolean>; truncated: boolean }> {
  const probes: Record<string, boolean> = {};
  const budgetStart = Date.now();
  let truncated = false;

  for (const spec of plan) {
    if (Date.now() - budgetStart > PROBE_BUDGET_MS) {
      truncated = true;
      break;
    }
    try {
      probes[spec.key] = await withTimeout(evalProbe(page, spec), PROBE_TIMEOUT_MS);
    } catch {
      // Omit the key entirely — predicates.ts's dom.* evalFns read an absent
      // key as 'unevaluable', matching every other predicate's contract.
    }
  }

  return { probes, truncated };
}
