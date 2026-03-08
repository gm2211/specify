/**
 * scripts/live-discover.ts — Live traffic discovery with request/response recording
 *
 * What it does:
 *   1. Loads stored session state into a Playwright browser (uses login.ts output)
 *   2. Navigates to each configured page and captures ALL network traffic
 *   3. Extracts JS bundle URLs from the DOM and mines them for API patterns
 *   4. Generates a detailed discovery report with response shapes and TypeScript interfaces
 *
 * Usage:
 *   npm run live-discover
 *   npx tsx scripts/live-discover.ts
 *
 * Configuration (via .env or environment variables):
 *   TARGET_BASE_URL      — base URL of the application (required)
 *   CAPTURE_HOST_FILTER  — hostname substring to capture traffic for (required)
 *   STORAGE_STATE_PATH   — Playwright storage state (default: .auth/storage-state.json)
 *   DISCOVER_DELAY_MS    — delay between requests in ms (default: 600)
 *   DISCOVER_OUTPUT_DIR  — output directory for reports (default: docs/)
 *   LIVE_DISCOVER_PAGES  — comma-separated page paths to visit (optional)
 *
 * Output (in DISCOVER_OUTPUT_DIR/):
 *   live-discovery.md          — full report with confirmed traffic
 *   live-discovery-raw.json    — raw exchanges for programmatic analysis
 *
 * Safety: All traffic is captured passively (no extra probing). Rate limiting applied between pages.
 */

import { chromium, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = process.env.TARGET_BASE_URL ?? '';
const HOST_FILTER = process.env.CAPTURE_HOST_FILTER ?? '';
const STORAGE_STATE_PATH = path.resolve(
  process.cwd(),
  process.env.STORAGE_STATE_PATH ?? '.auth/storage-state.json'
);
const OUTPUT_DIR = path.resolve(process.cwd(), process.env.DISCOVER_OUTPUT_DIR ?? 'docs');
const DELAY_MS = parseInt(process.env.DISCOVER_DELAY_MS ?? '600', 10);

const PAGES_TO_VISIT: string[] = (process.env.LIVE_DISCOVER_PAGES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!BASE_URL) {
  console.error('ERROR: TARGET_BASE_URL must be set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CapturedRequest {
  url: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  postData?: string;
}

interface CapturedResponse {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
}

interface CapturedExchange {
  page: string;
  request: CapturedRequest;
  response?: CapturedResponse;
  timestamp: number;
}

interface JsBundleInfo {
  url: string;
  size: number;
  apiPatterns: string[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const allExchanges: CapturedExchange[] = [];
const jsBundles: JsBundleInfo[] = [];
const allScriptUrls = new Set<string>();
const errors: { context: string; error: string }[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTargetRequest(url: string): boolean {
  const u = url.toLowerCase();
  // Skip analytics, tracking, and well-known third-party services
  const skipList = [
    'clarity.ms', 'google', 'facebook', 'bing.com',
    'analytics', 'newrelic', 'sentry', 'amplitude',
    'statuspage', 'cloudflare', 'doubleclick',
  ];
  if (skipList.some((s) => u.includes(s))) return false;
  return !HOST_FILTER || u.includes(HOST_FILTER.toLowerCase());
}

function isApiEndpoint(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes('/api/') ||
    u.includes('/v1/') ||
    u.includes('/v2/') ||
    u.includes('.ashx') ||
    u.includes('.asmx') ||
    u.includes('.aspx/') ||
    u.includes('/handler') ||
    u.includes('webservice') ||
    u.includes('/service') ||
    u.includes('.svc')
  );
}

function extractApiPatterns(jsContent: string): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();

  const regexes = [
    /(?:fetch|ajax|get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+(?:\/api\/|\.ashx|\.asmx|\.aspx|Handler|Service|WebService)[^'"`]*?)['"`]/gi,
    /['"`](\/(?:api|Api|API)\/[^'"`\s]+?)['"`]/g,
    /['"`](\/[^'"`\s]*?\.(?:ashx|asmx|svc)[^'"`\s]*?)['"`]/g,
    /['"`](\/[^'"`\s]*?\.aspx\/[^'"`\s]*?)['"`]/g,
    /(?:url|URL|endpoint|Endpoint|path|Path|href)\s*[:=]\s*['"`]([^'"`]+(?:\/api\/|\.ashx|\.asmx|\.aspx)[^'"`]*?)['"`]/gi,
    /\$\.(?:get|post|ajax)\s*\(\s*['"`]([^'"`]+?)['"`]/gi,
    /['"`](\/v\d+\/[A-Za-z][^'"`\s]{2,}?)['"`]/g,
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(jsContent)) !== null) {
      const url = match[1];
      if (
        !seen.has(url) &&
        url.length < 200 &&
        url.length > 3 &&
        !url.includes('\\n') &&
        !url.includes('  ')
      ) {
        seen.add(url);
        patterns.push(url);
      }
    }
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Capture page traffic
// ---------------------------------------------------------------------------
async function capturePageTraffic(context: BrowserContext, pagePath: string): Promise<void> {
  const fullUrl = pagePath.startsWith('http') ? pagePath : `${BASE_URL}${pagePath}`;
  console.log(`\n=== Visiting ${fullUrl} ===`);

  const page = await context.newPage();
  const pageExchanges = new Map<string, CapturedExchange>();

  page.on('request', (request: Request) => {
    const url = request.url();
    if (!isTargetRequest(url)) return;

    const exchange: CapturedExchange = {
      page: pagePath,
      request: {
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        headers: request.headers(),
        postData: request.postData() ?? undefined,
      },
      timestamp: Date.now(),
    };
    pageExchanges.set(`${url}_${Date.now()}`, exchange);
  });

  page.on('response', async (response: Response) => {
    const url = response.url();
    if (!isTargetRequest(url)) return;

    const key = Array.from(pageExchanges.keys())
      .reverse()
      .find((k) => k.startsWith(`${url}_`));
    if (!key) return;

    const exchange = pageExchanges.get(key)!;
    const contentType = response.headers()['content-type'] ?? '';

    let body: string | undefined;
    let bodyTruncated = false;

    try {
      if (
        contentType.includes('json') ||
        contentType.includes('text') ||
        contentType.includes('html') ||
        contentType.includes('xml')
      ) {
        const rawBody = await response.text();
        if (rawBody.length > 10000) {
          body = rawBody.substring(0, 10000);
          bodyTruncated = true;
        } else {
          body = rawBody;
        }
      }
    } catch {
      // Body may not be available
    }

    exchange.response = {
      url,
      status: response.status(),
      statusText: response.statusText(),
      contentType,
      headers: response.headers(),
      body,
      bodyTruncated,
    };
  });

  try {
    const response = await page.goto(fullUrl, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (response) {
      console.log(`  Status: ${response.status()} ${response.statusText()}`);
      const finalUrl = response.url();
      if (
        finalUrl.toLowerCase().includes('login') ||
        finalUrl.toLowerCase().includes('signin')
      ) {
        console.log(`  WARNING: Redirected to login — session may be expired`);
        errors.push({ context: pagePath, error: `Redirected to login: ${finalUrl}` });
      }
    }

    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map(
        (s) => (s as HTMLScriptElement).src
      )
    );
    scripts.forEach((s) => allScriptUrls.add(s));
    console.log(`  Found ${scripts.length} script tags`);

    const inlineScripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script:not([src])')).map((s) => s.textContent ?? '')
    );

    for (const script of inlineScripts) {
      const patterns = extractApiPatterns(script);
      if (patterns.length > 0) {
        jsBundles.push({ url: `${pagePath} (inline)`, size: script.length, apiPatterns: patterns });
      }
    }

    await sleep(2000); // wait for late-loading XHR

    for (const exchange of pageExchanges.values()) {
      allExchanges.push(exchange);
    }

    console.log(`  Captured ${pageExchanges.size} requests`);

    const apiReqs = Array.from(pageExchanges.values()).filter((e) =>
      isApiEndpoint(e.request.url)
    );
    if (apiReqs.length > 0) {
      for (const e of apiReqs) {
        console.log(
          `    ${e.request.method} ${e.request.url} -> ${e.response?.status ?? 'pending'}`
        );
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ERROR: ${msg}`);
    errors.push({ context: pagePath, error: msg });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Analyze JS bundles
// ---------------------------------------------------------------------------
async function analyzeJsBundles(context: BrowserContext): Promise<void> {
  const targetScripts = Array.from(allScriptUrls).filter(
    (u) => !HOST_FILTER || u.includes(HOST_FILTER)
  );
  console.log(`\n=== Analyzing ${targetScripts.length} JS bundles ===`);

  const page = await context.newPage();

  for (const scriptUrl of targetScripts) {
    console.log(`  Fetching: ${scriptUrl}`);
    try {
      const response = await page.goto(scriptUrl, { timeout: 15000 });
      if (response?.ok()) {
        const content = await response.text();
        const patterns = extractApiPatterns(content);
        if (patterns.length > 0) {
          jsBundles.push({ url: scriptUrl, size: content.length, apiPatterns: patterns });
          console.log(`    Found ${patterns.length} API patterns`);
        } else {
          console.log(`    No API patterns (${content.length} bytes)`);
        }
      }
      await sleep(500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`    Error: ${msg}`);
      errors.push({ context: `JS bundle: ${scriptUrl}`, error: msg });
    }
  }

  await page.close();
}

// ---------------------------------------------------------------------------
// Report generation helpers
// ---------------------------------------------------------------------------
function describeResponseShape(body: string, contentType: string): string {
  if (contentType?.includes('json')) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return `Array[${parsed.length}]`;
      if (typeof parsed === 'object' && parsed !== null) {
        const keys = Object.keys(parsed);
        return keys.length <= 5 ? `{${keys.join(', ')}}` : `Object(${keys.length} keys)`;
      }
      return typeof parsed;
    } catch {
      return 'Invalid JSON';
    }
  }
  if (contentType?.includes('html')) return 'HTML';
  if (contentType?.includes('xml')) return 'XML';
  return contentType?.split(';')[0] ?? 'unknown';
}

function urlToInterfaceName(url: string): string {
  const parts = url.replace(BASE_URL, '').split('/').filter(Boolean);
  const meaningful = parts.filter((p) => !p.includes('.') && !p.includes('?'));
  const name = meaningful
    .slice(-2)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  return (name || 'ApiResponse') + 'Response';
}

function generateInterface(data: unknown, name: string, depth = 0): string {
  if (depth > 3) return '';
  if (Array.isArray(data)) {
    if (data.length === 0) return `type ${name} = unknown[];`;
    const itemInterface = generateInterface(data[0], name.replace('Response', 'Item'), depth + 1);
    return `${itemInterface}\n\ntype ${name} = ${name.replace('Response', 'Item')}[];`;
  }
  if (typeof data !== 'object' || data === null) {
    return `type ${name} = ${typeof data};`;
  }
  const keys = Object.keys(data as Record<string, unknown>);
  if (keys.length === 0) return `type ${name} = Record<string, unknown>;`;

  let result = `interface ${name} {\n`;
  const subInterfaces: string[] = [];

  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    const tsType = inferTsType(value, name + key.charAt(0).toUpperCase() + key.slice(1), depth, subInterfaces);
    result += `  ${key}: ${tsType};\n`;
  }
  result += `}`;

  return subInterfaces.length > 0
    ? subInterfaces.join('\n\n') + '\n\n' + result
    : result;
}

function inferTsType(
  value: unknown,
  suggestedName: string,
  depth: number,
  subInterfaces: string[]
): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'unknown[]';
    const itemType = inferTsType(value[0], `${suggestedName}Item`, depth + 1, subInterfaces);
    return `${itemType}[]`;
  }
  if (typeof value === 'object') {
    if (depth < 2) {
      const iface = generateInterface(value, suggestedName, depth + 1);
      subInterfaces.push(iface);
      return suggestedName;
    }
    return 'Record<string, unknown>';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Main report
// ---------------------------------------------------------------------------
function generateReport(): string {
  const now = new Date().toISOString();

  const confirmedApi: CapturedExchange[] = [];
  const pageLoads: CapturedExchange[] = [];
  const assetLoads: CapturedExchange[] = [];

  for (const exchange of allExchanges) {
    const rt = exchange.request.resourceType;
    if (isApiEndpoint(exchange.request.url) || rt === 'xhr' || rt === 'fetch') {
      confirmedApi.push(exchange);
    } else if (rt === 'document') {
      pageLoads.push(exchange);
    } else {
      assetLoads.push(exchange);
    }
  }

  const uniqueApiEndpoints = new Map<string, CapturedExchange>();
  for (const e of confirmedApi) {
    const key = `${e.request.method} ${e.request.url.split('?')[0]}`;
    if (!uniqueApiEndpoints.has(key)) uniqueApiEndpoints.set(key, e);
  }

  const allApiPatterns = new Set<string>();
  for (const bundle of jsBundles) {
    for (const p of bundle.apiPatterns) allApiPatterns.add(p);
  }

  const sortedApiEndpoints = Array.from(uniqueApiEndpoints.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  let report = `# Live API Discovery Report

**Generated:** ${now}
**Base URL:** \`${BASE_URL}\`
**Host Filter:** \`${HOST_FILTER || '(none)'}\`
**Pages visited:** ${PAGES_TO_VISIT.join(', ') || '(none)'}

---

## Confirmed API Endpoints (from live network traffic)

| # | Method | URL | Status | Content-Type | Source Page | Response Shape |
|---|--------|-----|--------|-------------|-------------|----------------|
`;

  let idx = 1;
  for (const [, exchange] of sortedApiEndpoints) {
    const url = exchange.request.url.replace(BASE_URL, '');
    const status = exchange.response?.status ?? 'N/A';
    const ct = exchange.response?.contentType?.split(';')[0] ?? 'N/A';
    const shape = exchange.response?.body
      ? describeResponseShape(exchange.response.body, exchange.response.contentType ?? '')
      : 'N/A';
    report += `| ${idx} | ${exchange.request.method} | \`${url}\` | ${status} | ${ct} | ${exchange.page} | ${shape} |\n`;
    idx++;
  }

  report += `\n---\n\n## Response Details\n\n`;
  for (const [, exchange] of sortedApiEndpoints) {
    if (exchange.response?.body) {
      const shortUrl = exchange.request.url.replace(BASE_URL, '');
      report += `### \`${exchange.request.method} ${shortUrl}\`\n\n`;
      report += `**Status:** ${exchange.response.status}\n`;
      report += `**Content-Type:** ${exchange.response.contentType}\n`;
      if (exchange.response.contentType?.includes('json')) {
        try {
          const parsed = JSON.parse(exchange.response.body);
          report += `\n\`\`\`json\n${JSON.stringify(parsed, null, 2).substring(0, 3000)}\n\`\`\`\n`;
        } catch {
          report += `\n\`\`\`\n${exchange.response.body.substring(0, 2000)}\n\`\`\`\n`;
        }
      }
      report += `\n`;
    }
  }

  report += `---\n\n## TypeScript Interfaces (from actual response data)\n\n`;
  for (const [, exchange] of sortedApiEndpoints) {
    if (exchange.response?.body && exchange.response.contentType?.includes('json')) {
      try {
        const parsed = JSON.parse(exchange.response.body);
        const shortUrl = exchange.request.url.replace(BASE_URL, '').split('?')[0];
        const name = urlToInterfaceName(shortUrl);
        const iface = generateInterface(parsed, name);
        if (iface) {
          report += `### From \`${shortUrl}\`\n\n\`\`\`typescript\n${iface}\n\`\`\`\n\n`;
        }
      } catch {
        // skip non-JSON
      }
    }
  }

  report += `---\n\n## JS Bundle Analysis\n\n`;

  const targetScripts = Array.from(allScriptUrls).filter(
    (u) => !HOST_FILTER || u.includes(HOST_FILTER)
  );
  report += `**Target scripts (${targetScripts.length}):**\n`;
  for (const s of targetScripts) {
    report += `- \`${s.replace(BASE_URL, '')}\`\n`;
  }

  report += `\n### API Patterns Found in JS\n\n`;
  const confirmedSet = new Set<string>();
  const unconfirmedSet = new Set<string>();
  for (const pattern of allApiPatterns) {
    const wasConfirmed = confirmedApi.some((e) => e.request.url.includes(pattern));
    (wasConfirmed ? confirmedSet : unconfirmedSet).add(pattern);
  }

  if (confirmedSet.size > 0) {
    report += `**Confirmed (seen in traffic):**\n`;
    for (const p of confirmedSet) report += `- \`${p}\`\n`;
    report += `\n`;
  }
  if (unconfirmedSet.size > 0) {
    report += `**Unconfirmed (in JS, not seen in traffic):**\n`;
    for (const p of Array.from(unconfirmedSet).sort()) report += `- \`${p}\`\n`;
    report += `\n`;
  }

  report += `---\n\n## Errors\n\n`;
  if (errors.length === 0) {
    report += 'No errors encountered.\n';
  } else {
    report += `| Context | Error |\n|---------|-------|\n`;
    for (const e of errors) {
      report += `| ${e.context} | ${e.error.substring(0, 200)} |\n`;
    }
  }

  report += `\n---\n\n## Traffic Log\n\n`;
  report += `Total captured: ${allExchanges.length} (API: ${confirmedApi.length}, pages: ${pageLoads.length}, assets: ${assetLoads.length})\n`;

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== Live API Discovery ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Host filter: ${HOST_FILTER || '(none)'}`);
  console.log(`Pages to visit: ${PAGES_TO_VISIT.join(', ') || '(none)'}`);

  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`Storage state not found at: ${STORAGE_STATE_PATH}`);
    console.error('Run "npm run login" first.');
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  });

  try {
    for (const pagePath of PAGES_TO_VISIT) {
      await capturePageTraffic(context, pagePath);
      await sleep(DELAY_MS);
    }

    await analyzeJsBundles(context);

    console.log('\n--- Generating report ---');
    const report = generateReport();

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const reportPath = path.join(OUTPUT_DIR, 'live-discovery.md');
    fs.writeFileSync(reportPath, report);
    console.log(`Report: ${reportPath}`);

    const rawPath = path.join(OUTPUT_DIR, 'live-discovery-raw.json');
    fs.writeFileSync(
      rawPath,
      JSON.stringify(
        {
          exchanges: allExchanges,
          jsBundles,
          scriptUrls: Array.from(allScriptUrls),
          errors,
          timestamp: new Date().toISOString(),
          baseUrl: BASE_URL,
          hostFilter: HOST_FILTER,
        },
        null,
        2
      )
    );
    console.log(`Raw data: ${rawPath}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Fatal error:', msg);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

main().catch(console.error);
