/**
 * scripts/api-discover.ts — API discovery engine
 *
 * What it does:
 *   1. Loads stored session state (from login.ts) into a headless browser
 *   2. Phase 1: Validates authentication by loading the target base URL
 *   3. Phase 2: Mines frontend JavaScript bundles for fetch/ajax/API patterns
 *   4. Phase 2b: Intercepts network calls while navigating configured pages
 *   5. Phase 3: Probes discovered endpoints (GET only) with rate limiting
 *   6. Phase 4: Generates a discovery report (Markdown + raw JSON)
 *
 * Usage:
 *   npm run discover
 *   npx tsx scripts/api-discover.ts
 *
 * Configuration (via .env or environment variables):
 *   TARGET_BASE_URL      — base URL of the application (required)
 *   CAPTURE_HOST_FILTER  — hostname filter for traffic and probing (required)
 *   STORAGE_STATE_PATH   — path to Playwright storage state (default: .auth/storage-state.json)
 *   DISCOVER_DELAY_MS    — delay between requests in ms (default: 600)
 *   DISCOVER_OUTPUT_DIR  — output directory for reports (default: docs/)
 *   DISCOVER_PAGES       — comma-separated page paths to visit (optional)
 *
 * Output (in DISCOVER_OUTPUT_DIR/):
 *   api-discovery.md       — human-readable discovery report
 *   api-discovery-raw.json — raw data for programmatic analysis
 *
 * Safety: Only GET/HEAD/OPTIONS requests. Rate limiting built in (>=500ms between requests).
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
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

const PAGES_TO_VISIT: string[] = (process.env.DISCOVER_PAGES ?? '')
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
interface DiscoveredEndpoint {
  url: string;
  source: 'js-mining' | 'html-mining' | 'pattern-probe' | 'network-intercept';
  method: string;
  pattern?: string;
}

interface ProbeResult {
  url: string;
  status: number;
  contentType: string;
  redirectUrl?: string;
  bodyPreview: string;
  headers: Record<string, string>;
  source: string;
  error?: string;
}

interface JsAnalysis {
  scriptUrls: string[];
  apiPatterns: {
    url: string;
    context: string;
    type: string;
  }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeEndpoints(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((ep) => {
    const key = `${ep.method}:${ep.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Phase 1: Auth validation
// ---------------------------------------------------------------------------
async function validateAuth(
  context: BrowserContext
): Promise<{ page: Page; authenticated: boolean }> {
  console.log('\n=== Phase 1: Auth Validation ===');
  const page = await context.newPage();

  try {
    const response = await page.goto(`${BASE_URL}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const finalUrl = page.url();
    const status = response?.status() ?? 0;
    console.log(`  Response: ${status}, final URL: ${finalUrl}`);

    const isLoginPage =
      finalUrl.toLowerCase().includes('login') ||
      finalUrl.toLowerCase().includes('signin');

    if (isLoginPage) {
      console.log('  WARNING: Redirected to login — session may be expired');
      return { page, authenticated: false };
    }

    const title = await page.title();
    console.log(`  Page title: ${title}`);

    return { page, authenticated: status >= 200 && status < 400 };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Error loading base URL: ${msg}`);
    return { page, authenticated: false };
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Mine frontend JavaScript
// ---------------------------------------------------------------------------
async function mineJavaScript(page: Page, context: BrowserContext): Promise<JsAnalysis> {
  console.log('\n=== Phase 2: Mine Frontend JavaScript ===');

  const analysis: JsAnalysis = {
    scriptUrls: [],
    apiPatterns: [],
  };

  const scriptSrcs = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[src]');
    return Array.from(scripts).map((s) => (s as HTMLScriptElement).src);
  });

  console.log(`  Found ${scriptSrcs.length} external script tags`);
  analysis.scriptUrls = scriptSrcs;

  const inlineScripts = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script:not([src])');
    return Array.from(scripts)
      .map((s) => s.textContent ?? '')
      .filter((s) => s.length > 10);
  });
  console.log(`  Found ${inlineScripts.length} inline scripts`);

  for (const script of inlineScripts) {
    extractApiPatterns(script, 'inline-script', analysis);
  }

  // Analyze external JS files matching the host filter
  const targetScripts = scriptSrcs.filter(
    (src) =>
      (HOST_FILTER && src.includes(HOST_FILTER)) ||
      src.startsWith('/') ||
      src.startsWith(BASE_URL)
  );

  console.log(`  Fetching ${targetScripts.length} target JS files...`);

  for (const scriptUrl of targetScripts) {
    const fullUrl = scriptUrl.startsWith('http') ? scriptUrl : `${BASE_URL}${scriptUrl}`;
    console.log(`  Fetching: ${fullUrl}`);

    try {
      const jsResponse = await context.request.get(fullUrl);
      if (jsResponse.ok()) {
        const jsContent = await jsResponse.text();
        console.log(`    Got ${jsContent.length} chars`);
        extractApiPatterns(jsContent, fullUrl, analysis);
      } else {
        console.log(`    HTTP ${jsResponse.status()}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    Error: ${msg}`);
    }

    await sleep(DELAY_MS);
  }

  // Also mine the page HTML
  const html = await page.content();
  extractApiPatterns(html, 'page-html', analysis);

  console.log(`\n  Total API patterns found: ${analysis.apiPatterns.length}`);
  return analysis;
}

function extractApiPatterns(source: string, sourceFile: string, analysis: JsAnalysis): void {
  const patterns: { regex: RegExp; type: string }[] = [
    { regex: /fetch\s*\(\s*["'`]([^"'`]+)["'`]/g, type: 'fetch' },
    { regex: /\$\.ajax\s*\(\s*\{[^}]*url\s*:\s*["'`]([^"'`]+)["'`]/g, type: 'jquery-ajax' },
    { regex: /\$\.get\s*\(\s*["'`]([^"'`]+)["'`]/g, type: 'jquery-get' },
    { regex: /\$\.post\s*\(\s*["'`]([^"'`]+)["'`]/g, type: 'jquery-post' },
    { regex: /\$\.getJSON\s*\(\s*["'`]([^"'`]+)["'`]/g, type: 'jquery-getJSON' },
    {
      regex: /\.open\s*\(\s*["'`](?:GET|POST|PUT|DELETE)["'`]\s*,\s*["'`]([^"'`]+)["'`]/g,
      type: 'xhr',
    },
    { regex: /["'`](\/api\/[^"'`\s]+)["'`]/g, type: 'api-url' },
    { regex: /["'`](\/v\d+\/[^"'`\s]+)["'`]/g, type: 'versioned-api-url' },
    {
      regex: /url\s*[:=]\s*["'`]([^"'`]+(?:\/api\/)[^"'`]*)["'`]/gi,
      type: 'url-assignment',
    },
    {
      regex: /(?:window\.location|navigate|redirect|href)\s*=\s*["'`]([^"'`]+)["'`]/gi,
      type: 'navigation',
    },
  ];

  // Analytics/CDN domains to skip
  const SKIP_PATTERNS = [
    'googleapis.com', 'google-analytics', 'facebook', 'clarity.ms',
    'cloudflare', 'fonts.', 'cdn.', '.css', '.png', '.jpg',
  ];

  for (const { regex, type } of patterns) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      const url = match[1];

      if (SKIP_PATTERNS.some((p) => url.includes(p))) continue;
      if (url.length < 3 || url === '/') continue;

      const start = Math.max(0, match.index - 80);
      const end = Math.min(source.length, match.index + match[0].length + 80);
      const context = source.slice(start, end).replace(/\n/g, ' ').trim();

      analysis.apiPatterns.push({ url, context, type });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2b: Network interception during navigation
// ---------------------------------------------------------------------------
async function interceptNetworkCalls(page: Page): Promise<DiscoveredEndpoint[]> {
  console.log('\n=== Phase 2b: Network Interception During Navigation ===');
  const intercepted: DiscoveredEndpoint[] = [];

  if (PAGES_TO_VISIT.length === 0) {
    console.log('  No pages configured (DISCOVER_PAGES is empty). Skipping.');
    return intercepted;
  }

  page.on('request', (request) => {
    const url = request.url();
    const skip = /\.(css|js|png|jpg|gif|svg|woff|ico|ttf)(\?|$)/;
    if (HOST_FILTER && !url.includes(HOST_FILTER)) return;
    if (skip.test(url)) return;

    intercepted.push({
      url,
      source: 'network-intercept',
      method: request.method(),
    });
  });

  for (const pagePath of PAGES_TO_VISIT) {
    const fullUrl = pagePath.startsWith('http') ? pagePath : `${BASE_URL}${pagePath}`;
    console.log(`  Visiting ${fullUrl}...`);
    try {
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 15000 });
      console.log(`    OK - ${page.url()}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    Error: ${msg.slice(0, 100)}`);
    }
    await sleep(DELAY_MS);
  }

  return intercepted;
}

// ---------------------------------------------------------------------------
// Phase 3: Probe endpoints (GET only)
// ---------------------------------------------------------------------------
async function probeEndpoints(
  endpoints: DiscoveredEndpoint[],
  context: BrowserContext
): Promise<ProbeResult[]> {
  console.log('\n=== Phase 3: Probe Discovered Endpoints (GET only) ===');
  const results: ProbeResult[] = [];

  const urlsToProbe = new Set<string>();
  for (const ep of endpoints) {
    let url = ep.url;
    if (url.startsWith('/')) {
      url = `${BASE_URL}${url}`;
    }
    if (HOST_FILTER && !url.includes(HOST_FILTER)) continue;
    if (!url.startsWith('http')) continue;
    urlsToProbe.add(url);
  }

  console.log(`  ${urlsToProbe.size} unique URLs to probe`);

  let i = 0;
  for (const url of urlsToProbe) {
    i++;
    console.log(`  [${i}/${urlsToProbe.size}] GET ${url}`);

    try {
      const response = await context.request.get(url, {
        timeout: 10000,
        headers: {
          Accept: 'application/json, text/html, */*',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      const status = response.status();
      const headers = response.headers();
      const contentType = headers['content-type'] ?? '';

      let bodyPreview = '';
      try {
        const body = await response.text();
        bodyPreview = body.slice(0, 2000);
      } catch {
        bodyPreview = '[Could not read body]';
      }

      console.log(`    -> ${status} ${contentType.split(';')[0]}`);

      results.push({
        url,
        status,
        contentType,
        bodyPreview,
        headers,
        source:
          endpoints.find((ep) => url.endsWith(ep.url) || url === ep.url)?.source ?? 'unknown',
      });

      if (status === 429) {
        console.log('  RATE LIMITED (429) - stopping probes');
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    -> ERROR: ${msg.slice(0, 100)}`);
      results.push({
        url,
        status: 0,
        contentType: '',
        bodyPreview: '',
        headers: {},
        source: 'error',
        error: msg,
      });
    }

    await sleep(DELAY_MS);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase 4: Generate report
// ---------------------------------------------------------------------------
function generateReport(
  jsAnalysis: JsAnalysis,
  probeResults: ProbeResult[],
  networkEndpoints: DiscoveredEndpoint[],
  authenticated: boolean
): string {
  const successfulEndpoints = probeResults.filter((r) => r.status >= 200 && r.status < 400);
  const jsonEndpoints = successfulEndpoints.filter((r) => r.contentType.includes('json'));
  const failedEndpoints = probeResults.filter((r) => r.status >= 400 || r.status === 0);

  let doc = `# API Discovery Report

Generated: ${new Date().toISOString()}
Base URL: ${BASE_URL}
Host Filter: ${HOST_FILTER || '(none)'}
Session authenticated: ${authenticated ? 'Yes' : 'No (expired or not set up)'}

## Frontend JavaScript Analysis

### Script Files Found
${
  jsAnalysis.scriptUrls.length > 0
    ? jsAnalysis.scriptUrls.map((u) => `- \`${u}\``).join('\n')
    : '- No external scripts found'
}

### API Patterns Discovered from JS
${
  jsAnalysis.apiPatterns.length > 0
    ? `Found ${jsAnalysis.apiPatterns.length} API pattern references in JavaScript:\n\n` +
      `| URL Pattern | Type | Context |\n|------------|------|---------|` +
      jsAnalysis.apiPatterns
        .map(
          (p) =>
            `\n| \`${p.url.slice(0, 80)}\` | ${p.type} | \`${p.context.slice(0, 60).replace(/\|/g, '\\|')}\` |`
        )
        .join('')
    : 'No API patterns found in JavaScript'
}

## Network-Intercepted Endpoints

${
  networkEndpoints.length > 0
    ? `Found ${networkEndpoints.length} network requests during page navigation:\n\n` +
      `| Method | URL | Source |\n|--------|-----|--------|` +
      dedupeEndpoints(networkEndpoints)
        .map((ep) => `\n| ${ep.method} | \`${ep.url.slice(0, 80)}\` | ${ep.source} |`)
        .join('')
    : 'No network endpoints intercepted'
}

## Discovered Endpoints

### Successful Endpoints (2xx-3xx)
${
  successfulEndpoints.length > 0
    ? `| URL | Status | Content-Type | Source |\n|-----|--------|-------------|--------|` +
      successfulEndpoints
        .map(
          (r) =>
            `\n| \`${r.url.replace(BASE_URL, '')}\` | ${r.status} | ${r.contentType.split(';')[0]} | ${r.source} |`
        )
        .join('')
    : 'No successful endpoint responses received'
}

### JSON API Endpoints
${
  jsonEndpoints.length > 0
    ? jsonEndpoints
        .map((r) => {
          let schema = '';
          try {
            const parsed = JSON.parse(r.bodyPreview);
            schema = generateTypeScript(parsed, getEndpointName(r.url));
          } catch {
            schema = `// Response preview: ${r.bodyPreview.slice(0, 200)}`;
          }
          return (
            `\n#### \`GET ${r.url.replace(BASE_URL, '')}\`\n` +
            `- Status: ${r.status}\n` +
            `- Content-Type: ${r.contentType}\n\n` +
            `Response preview:\n\`\`\`json\n${r.bodyPreview.slice(0, 500)}\n\`\`\`\n\n` +
            `TypeScript interface:\n\`\`\`typescript\n${schema}\n\`\`\`\n`
          );
        })
        .join('\n')
    : 'No JSON endpoints discovered'
}

### Failed/Blocked Endpoints
${
  failedEndpoints.length > 0
    ? `| URL | Status | Error |\n|-----|--------|-------|` +
      failedEndpoints
        .slice(0, 50)
        .map(
          (r) =>
            `\n| \`${r.url.replace(BASE_URL, '').slice(0, 60)}\` | ${r.status} | ${(r.error ?? '').slice(0, 50)} |`
        )
        .join('')
    : 'No failed endpoints'
}
`;

  return doc;
}

function getEndpointName(url: string): string {
  const parts = url.replace(BASE_URL, '').split('/').filter(Boolean);
  return (parts[parts.length - 1]?.replace(/[^a-zA-Z]/g, '') ?? '') || 'Response';
}

function generateTypeScript(obj: unknown, name: string, depth = 0): string {
  if (depth > 3) return '  // ... (deeply nested)';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `interface ${name} {\n  // Empty array\n}`;
    return generateTypeScript(obj[0], name, depth);
  }
  if (typeof obj !== 'object' || obj === null) {
    return `type ${name} = ${typeof obj};`;
  }
  const lines = [`interface ${name} {`];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const type = getTypeString(value, depth + 1);
    lines.push(`  ${key}: ${type};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function getTypeString(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'any[]';
    return `${getTypeString(value[0], depth)}[]`;
  }
  if (typeof value === 'object') {
    if (depth > 3) return 'Record<string, any>';
    const props = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${getTypeString(v, depth + 1)}`
    );
    return `{ ${props.join('; ')} }`;
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== API Discovery ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Host filter: ${HOST_FILTER || '(none)'}`);
  console.log(`Pages to visit: ${PAGES_TO_VISIT.length > 0 ? PAGES_TO_VISIT.join(', ') : '(none)'}`);

  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`\nStorage state not found at: ${STORAGE_STATE_PATH}`);
    console.error('Run "npm run login" first to capture a session.');
    process.exit(1);
  }

  console.log('Launching browser with stored session...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    const { page, authenticated } = await validateAuth(context);

    if (!authenticated) {
      console.log(
        '\nWARNING: Not authenticated. Proceeding with limited discovery from public pages.'
      );
    }

    const jsAnalysis = await mineJavaScript(page, context);
    const networkEndpoints = await interceptNetworkCalls(page);

    const allEndpoints: DiscoveredEndpoint[] = [
      ...jsAnalysis.apiPatterns.map((p) => ({
        url: p.url,
        source: 'js-mining' as const,
        method: 'GET',
        pattern: p.type,
      })),
      ...networkEndpoints,
    ];

    const uniqueEndpoints = dedupeEndpoints(allEndpoints);
    console.log(`\nTotal unique endpoints to probe: ${uniqueEndpoints.length}`);

    const probeResults = await probeEndpoints(uniqueEndpoints, context);

    console.log('\n=== Phase 4: Generate Documentation ===');
    const doc = generateReport(jsAnalysis, probeResults, networkEndpoints, authenticated);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(OUTPUT_DIR, 'api-discovery.md');
    fs.writeFileSync(outputPath, doc, 'utf-8');
    console.log(`\nDocumentation written to: ${outputPath}`);

    const rawDataPath = path.join(OUTPUT_DIR, 'api-discovery-raw.json');
    fs.writeFileSync(
      rawDataPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          authenticated,
          baseUrl: BASE_URL,
          hostFilter: HOST_FILTER,
          jsAnalysis,
          networkEndpoints,
          probeResults,
        },
        null,
        2
      ),
      'utf-8'
    );
    console.log(`Raw data written to: ${rawDataPath}`);
  } finally {
    await browser.close();
  }

  console.log('\n=== Discovery Complete ===');
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
