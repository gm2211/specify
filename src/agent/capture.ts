/**
 * src/agent/capture.ts — Capture collector for the agent runner
 *
 * Wraps Playwright's request/response interception, collects console logs,
 * manages screenshot naming and storage, and outputs the standard capture
 * format that the validator expects.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext, Page } from 'playwright';
import type { CapturedTraffic, CapturedConsoleEntry, CaptureManifest } from '../capture/types.js';

const STATIC_EXT = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.woff', '.woff2', '.ttf', '.ico', '.map', '.less',
]);

function shouldCapture(url: string, hostFilter: string): boolean {
  try {
    const u = new URL(url);
    if (hostFilter && !u.hostname.includes(hostFilter)) return false;
    const ext = path.extname(u.pathname).toLowerCase();
    if (STATIC_EXT.has(ext)) return false;
    return true;
  } catch {
    return false;
  }
}

function slugify(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname
      .replace(/^\//, '')
      .replace(/[/?&#=.]/g, '_')
      .replace(/_+/g, '_')
      .replace(/_$/, '')
      .substring(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

export interface CaptureCollectorOptions {
  outputDir: string;
  targetUrl: string;
  hostFilter?: string;
}

export class CaptureCollector {
  private traffic: CapturedTraffic[] = [];
  private consoleLogs: CapturedConsoleEntry[] = [];
  private screenshotCount = 0;
  private outputDir: string;
  private screenshotDir: string;
  private targetUrl: string;
  private hostFilter: string;
  private startTime: string;

  constructor(options: CaptureCollectorOptions) {
    this.outputDir = path.resolve(options.outputDir);
    this.screenshotDir = path.join(this.outputDir, 'screenshots');
    this.targetUrl = options.targetUrl;
    this.hostFilter = options.hostFilter ?? '';
    this.startTime = new Date().toISOString();

    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  /** Attach traffic interception to a browser context. */
  async attachToContext(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method();

      const response = await route.fetch().catch(() => null);
      if (!response) {
        await route.continue().catch(() => {});
        return;
      }

      await route.fulfill({ response }).catch(() => {});

      if (shouldCapture(url, this.hostFilter)) {
        const entry: CapturedTraffic = {
          url,
          method,
          postData: request.postData() ?? null,
          status: response.status(),
          contentType: response.headers()['content-type'] ?? '',
          ts: Date.now(),
          responseBody: null,
        };

        const ct = (entry.contentType ?? '').toLowerCase();
        if (ct.includes('json') || ct.includes('text')) {
          try {
            const body = await response.text();
            if (body.length < 2 * 1024 * 1024) {
              entry.responseBody = body;
            }
          } catch {
            // ignore
          }
        }

        this.traffic.push(entry);
      }
    });
  }

  /** Attach console log capture to a page. */
  attachToPage(page: Page): void {
    page.on('console', (msg) => {
      this.consoleLogs.push({
        type: msg.type(),
        text: msg.text(),
        ts: Date.now(),
      });
    });
  }

  /** Take a named screenshot. Returns the file path. */
  async screenshot(page: Page, name?: string): Promise<string> {
    const idx = String(this.screenshotCount + 1).padStart(3, '0');
    const slug = name ? name.replace(/[^a-z0-9_-]/gi, '_').substring(0, 60) : slugify(page.url());
    const filename = `${idx}-${slug}.png`;
    const filepath = path.join(this.screenshotDir, filename);

    try {
      await page.screenshot({ path: filepath, fullPage: true });
      this.screenshotCount++;
    } catch {
      // ignore screenshot failures
    }

    return filepath;
  }

  /** Record traffic entries manually (e.g. from hook calls). */
  addTraffic(entry: CapturedTraffic): void {
    this.traffic.push(entry);
  }

  /** Get all collected traffic. */
  getTraffic(): CapturedTraffic[] {
    return this.traffic;
  }

  /** Get all collected console logs. */
  getConsoleLogs(): CapturedConsoleEntry[] {
    return this.consoleLogs;
  }

  /** Save all capture data to disk and return the manifest. */
  save(): CaptureManifest {
    // Write traffic.json
    const trafficPath = path.join(this.outputDir, 'traffic.json');
    fs.writeFileSync(trafficPath, JSON.stringify(this.traffic, null, 2), 'utf-8');

    // Write console.json
    const consolePath = path.join(this.outputDir, 'console.json');
    fs.writeFileSync(consolePath, JSON.stringify(this.consoleLogs, null, 2), 'utf-8');

    // Enumerate screenshot files
    const screenshotFiles = fs.existsSync(this.screenshotDir)
      ? fs.readdirSync(this.screenshotDir)
          .filter((f) => f.endsWith('.png'))
          .sort()
          .map((f) => path.join('screenshots', f))
      : [];

    // Write summary.txt
    const endpointMap = new Map<string, { method: string; url: string; status: number | string; count: number }>();
    for (const req of this.traffic) {
      let pattern: string;
      try {
        const u = new URL(req.url);
        pattern = `${u.origin}${u.pathname}`;
      } catch {
        pattern = req.url;
      }
      const key = `${req.method}::${pattern}::${req.status ?? '?'}`;
      const existing = endpointMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        endpointMap.set(key, { method: req.method, url: pattern, status: req.status ?? '?', count: 1 });
      }
    }

    const sorted = [...endpointMap.values()].sort((a, b) => b.count - a.count);
    const summaryLines = [
      `Capture: ${this.startTime}`,
      `Target: ${this.targetUrl}`,
      `Total requests: ${this.traffic.length}`,
      `Unique endpoints: ${sorted.length}`,
      `Screenshots: ${this.screenshotCount}`,
      `Console logs: ${this.consoleLogs.length}`,
      '',
      ...sorted.map((s) => `${s.method.padEnd(7)} ${String(s.status).padEnd(7)} ${s.url}`),
    ];
    fs.writeFileSync(path.join(this.outputDir, 'summary.txt'), summaryLines.join('\n') + '\n', 'utf-8');

    // Build and write manifest
    const manifest: CaptureManifest = {
      session: {
        timestamp: this.startTime,
        targetUrl: this.targetUrl,
        hostFilter: this.hostFilter,
        outputDir: this.outputDir,
        totalRequests: this.traffic.length,
        totalScreenshots: this.screenshotCount,
        pagesVisited: new Set(this.traffic.filter((t) => t.method === 'GET').map((t) => {
          try { return new URL(t.url).pathname; } catch { return t.url; }
        })).size,
        consoleLogCount: this.consoleLogs.length,
      },
      trafficFile: 'traffic.json',
      consoleFile: 'console.json',
      screenshotFiles,
      summaryFile: 'summary.txt',
    };

    fs.writeFileSync(path.join(this.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    return manifest;
  }
}
