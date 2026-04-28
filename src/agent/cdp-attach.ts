/**
 * src/agent/cdp-attach.ts — Attach Playwright to a user-driven Chrome via CDP.
 *
 * Tier-2 cooperative-QA needs the agent to share the user's browser context
 * rather than launching its own. Run Chrome with
 *   `chrome --remote-debugging-port=9222`
 * (or set CHROME_CDP_PORT) and call `attachToUserChrome()` to get a Playwright
 * Browser + first BrowserContext + first Page connected to that running
 * instance. The agent then observes (and optionally drives) the same tab the
 * user is on.
 *
 * The attach helper also instruments the page so user actions surface as
 * event-bus events:
 *   - `browser:navigation`  — URL changed
 *   - `browser:click`       — left-click on a DOM element (basic selector + text)
 *   - `browser:input`       — value typed into an input/textarea
 *   - `browser:console`     — page console message
 * Other modules (session replay, context-rich feedback) consume these.
 *
 * The helper does NOT depend on a verify run being in flight — you can
 * attach during a passive QA session where only the user is acting.
 */

import { eventBus } from './event-bus.js';
import type { Browser, BrowserContext, Page } from 'playwright';

export interface AttachOptions {
  /** Override the CDP endpoint (e.g. `http://localhost:9222`). Default: derived from port. */
  endpoint?: string;
  /** TCP port Chrome's remote-debugging is listening on. Default: $CHROME_CDP_PORT or 9222. */
  port?: number;
  /** sessionId to tag emitted events with. */
  sessionId?: string;
  /** When true, attach without instrumenting page events. */
  observeOnly?: boolean;
}

export interface AttachedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Detach instrumentation (does not close the browser; user keeps using it). */
  detach: () => void;
  /** Disconnect Playwright from the user's Chrome. Does NOT close the user's Chrome. */
  disconnect: () => Promise<void>;
}

export function defaultCdpEndpoint(port?: number): string {
  const resolved = port
    ?? (process.env.CHROME_CDP_PORT ? Number(process.env.CHROME_CDP_PORT) : undefined)
    ?? 9222;
  return `http://localhost:${resolved}`;
}

export async function attachToUserChrome(opts: AttachOptions = {}): Promise<AttachedSession> {
  const endpoint = opts.endpoint ?? defaultCdpEndpoint(opts.port);
  const { chromium } = await import('playwright');

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to connect to Chrome at ${endpoint}: ${msg}. ` +
      `Start Chrome with --remote-debugging-port=${opts.port ?? 9222} or set CHROME_CDP_PORT.`,
    );
  }

  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  const detachers: Array<() => void> = [];
  if (!opts.observeOnly) {
    instrumentPage(page, opts.sessionId, detachers);
    // Also instrument any new pages opened later (so the agent doesn't miss
    // when the user opens a fresh tab in the same context).
    const onNewPage = (p: Page): void => instrumentPage(p, opts.sessionId, detachers);
    context.on('page', onNewPage);
    detachers.push(() => context.off('page', onNewPage));
  }

  return {
    browser,
    context,
    page,
    detach: () => {
      while (detachers.length) {
        const d = detachers.pop();
        try { d?.(); } catch { /* noop */ }
      }
    },
    disconnect: async () => {
      try { await browser.close(); } catch { /* noop — browser may have been disconnected */ }
    },
  };
}

function instrumentPage(page: Page, sessionId: string | undefined, detachers: Array<() => void>): void {
  const onFrameNavigated = (frame: { url(): string; parentFrame(): unknown | null }): void => {
    if (frame.parentFrame()) return; // top-frame only
    eventBus.send('browser:navigation', { url: frame.url() }, sessionId);
  };
  page.on('framenavigated', onFrameNavigated);
  detachers.push(() => page.off('framenavigated', onFrameNavigated));

  const onConsole = (msg: { type(): string; text(): string }): void => {
    eventBus.send('browser:console', { level: msg.type(), text: msg.text() }, sessionId);
  };
  page.on('console', onConsole);
  detachers.push(() => page.off('console', onConsole));

  // Inject an in-page click/input observer the first time the page loads.
  // Future navigations re-add it via the framenavigated handler.
  const installObserver = async (): Promise<void> => {
    try {
      await page.evaluate(installInPageObserver.toString() + ';' + 'installInPageObserver();');
    } catch {
      // Page may have already navigated; ignore.
    }
  };
  void installObserver();
  page.on('framenavigated', (frame) => {
    if (!frame.parentFrame()) void installObserver();
  });

  // The in-page observer dispatches CustomEvents that we forward via exposeBinding.
  const bindingName = '__specify_user_event__';
  const onUserEvent = (_src: unknown, payload: Record<string, unknown>): void => {
    if (!payload || typeof payload !== 'object') return;
    const kind = String(payload.kind ?? 'unknown');
    eventBus.send(`browser:${kind}`, payload, sessionId);
  };
  void page.exposeBinding(bindingName, onUserEvent).catch(() => {
    // Binding may already be registered if attach is called twice. Ignore.
  });
  detachers.push(() => {
    void page.evaluate((name) => { try { (window as unknown as Record<string, unknown>)[name] = undefined; } catch { /* noop */ } }, bindingName).catch(() => { /* noop */ });
  });
}

/**
 * Small in-page observer that posts user actions back to Node via the
 * exposed `__specify_user_event__` binding. Stringified into the page so it
 * runs in the page's JS context.
 */
function installInPageObserver(): void {
  const w = window as unknown as { __specify_user_event__?: (payload: unknown) => void; __specify_observer_installed__?: boolean };
  if (w.__specify_observer_installed__) return;
  w.__specify_observer_installed__ = true;

  const send = (payload: unknown): void => {
    try { w.__specify_user_event__?.(payload); } catch { /* noop */ }
  };

  const describe = (el: Element | null): { tag: string; id: string; cls: string; text: string } => {
    if (!el) return { tag: '', id: '', cls: '', text: '' };
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 80) : '',
      text: (el.textContent ?? '').trim().slice(0, 120),
    };
  };

  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    send({ kind: 'click', element: describe(target), x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
  }, true);

  document.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA')) return;
    send({ kind: 'input', element: describe(target), valueLen: (target.value ?? '').length });
  }, true);
}
