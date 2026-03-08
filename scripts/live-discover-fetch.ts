/**
 * scripts/live-discover-fetch.ts — Browser-free API discovery via Node.js fetch
 *
 * What it does:
 *   1. Reads cookies from stored session state (from login.ts)
 *   2. Sends HTTP requests to configured pages and API endpoints using Node.js fetch
 *   3. Detects auth redirects, rate limiting, and bot-detection challenges
 *   4. Mines any HTML responses for script URLs and inline API patterns
 *   5. Fetches and analyzes JS bundles for additional API patterns
 *   6. Generates a discovery report
 *
 * Use this as a lightweight alternative to live-discover.ts when:
 *   - No browser environment is available
 *   - Quick probing without Playwright overhead is desired
 *
 * Caveat: Bot detection (e.g. Cloudflare) may block direct fetch requests.
 * Use live-discover.ts (Playwright-based) for sites with aggressive bot protection.
 *
 * Usage:
 *   npm run live-discover-fetch
 *   npx tsx scripts/live-discover-fetch.ts
 *
 * Configuration (via .env or environment variables):
 *   TARGET_BASE_URL      — base URL of the application (required)
 *   CAPTURE_HOST_FILTER  — hostname substring to filter for (optional)
 *   STORAGE_STATE_PATH   — Playwright storage state file (default: .auth/storage-state.json)
 *   DISCOVER_DELAY_MS    — delay between requests in ms (default: 600)
 *   DISCOVER_OUTPUT_DIR  — output directory (default: docs/)
 *   LIVE_DISCOVER_PAGES  — comma-separated page paths to visit (optional)
 *
 * Output (in DISCOVER_OUTPUT_DIR/):
 *   live-discovery-fetch.md         — discovery report
 *   live-discovery-fetch-raw.json   — raw results
 */

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
interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

interface StorageState {
  cookies: StoredCookie[];
  origins: unknown[];
}

interface ProbeResult {
  url: string;
  method: string;
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  error?: string;
  redirectedTo?: string;
  botBlocked?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadStorageState(): StorageState {
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error(`Storage state not found at: ${STORAGE_STATE_PATH}`);
    console.error('Run "npm run login" first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf-8')) as StorageState;
}

function buildCookieHeader(storageState: StorageState): string {
  let targetDomain: string;
  try {
    targetDomain = new URL(BASE_URL).hostname;
  } catch {
    targetDomain = '';
  }

  return storageState.cookies
    .filter((c) => {
      if (!targetDomain) return true;
      const domain = c.domain.replace(/^\./, '');
      return targetDomain.endsWith(domain) || domain.endsWith(targetDomain.replace(/^[^.]+\./, ''));
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function checkBotBlock(body: string, status: number, serverHeader: string): boolean {
  return (
    body.includes('cf-browser-verification') ||
    body.includes('Attention Required') ||
    body.includes('cf_chl_opt') ||
    body.includes('challenge-platform') ||
    body.includes('Just a moment...') ||
    (status === 403 && serverHeader.toLowerCase().includes('cloudflare'))
  );
}

function extractApiPatterns(jsContent: string): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();

  const regexes = [
    /(?:fetch|ajax|get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+(?:\/api\/|\.ashx|\.asmx|\.aspx|Handler|Service|WebService)[^'"`]*?)['"`]/gi,
    /['"`](\/(?:api|Api|API)\/[^'"`\s]{3,}?)['"`]/g,
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
// Probe helpers
// ---------------------------------------------------------------------------
async function probeDocument(
  urlPath: string,
  cookieHeader: string
): Promise<ProbeResult> {
  const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
  console.log(`  GET ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') ?? '';
    const serverHeader = response.headers.get('server') ?? '';
    const rawBody = await response.text();
    const body = rawBody.length > 10000 ? rawBody.substring(0, 10000) : rawBody;
    const bodyTruncated = rawBody.length > 10000;
    const botBlocked = checkBotBlock(rawBody, response.status, serverHeader);

    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => { headers[k] = v; });

    const result: ProbeResult = {
      url,
      method: 'GET',
      status: response.status,
      statusText: response.statusText,
      contentType,
      headers,
      body,
      bodyTruncated,
      botBlocked,
    };
    if (response.redirected) result.redirectedTo = response.url;

    console.log(
      `    -> ${response.status} [${contentType.split(';')[0]}]` +
      `${botBlocked ? ' [BOT-BLOCKED]' : ''}` +
      `${response.redirected ? ` -> ${response.url}` : ''}`
    );
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    -> ERROR: ${msg}`);
    return {
      url,
      method: 'GET',
      status: 0,
      statusText: '',
      contentType: '',
      headers: {},
      error: msg,
    };
  }
}

async function probeXhr(
  urlPath: string,
  cookieHeader: string
): Promise<ProbeResult> {
  const url = urlPath.startsWith('http') ? urlPath : `${BASE_URL}${urlPath}`;
  console.log(`  XHR GET ${url}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.5',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') ?? '';
    const serverHeader = response.headers.get('server') ?? '';
    const rawBody = await response.text();
    const body = rawBody.length > 10000 ? rawBody.substring(0, 10000) : rawBody;
    const bodyTruncated = rawBody.length > 10000;
    const botBlocked = checkBotBlock(rawBody, response.status, serverHeader);

    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => { headers[k] = v; });

    const result: ProbeResult = {
      url,
      method: 'GET',
      status: response.status,
      statusText: response.statusText,
      contentType,
      headers,
      body,
      bodyTruncated,
      botBlocked,
    };
    if (response.redirected) result.redirectedTo = response.url;

    console.log(
      `    -> ${response.status} [${contentType.split(';')[0]}]` +
      `${botBlocked ? ' [BOT-BLOCKED]' : ''}` +
      `${response.redirected ? ` -> ${response.url}` : ''}`
    );
    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    -> ERROR: ${msg}`);
    return {
      url,
      method: 'GET',
      status: 0,
      statusText: '',
      contentType: '',
      headers: {},
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------
function urlToInterfaceName(url: string): string {
  const parts = url.replace(BASE_URL, '').split('/').filter(Boolean);
  const meaningful = parts.filter((p) => !p.includes('.') && !p.includes('?'));
  const name = meaningful.slice(-2).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return (name || 'ApiResponse') + 'Response';
}

function generateTypeScript(data: unknown, name: string, depth = 0): string {
  if (depth > 3) return `type ${name} = unknown;`;
  if (data === null) return `type ${name} = null;`;
  if (typeof data !== 'object') return `type ${name} = ${typeof data};`;
  if (Array.isArray(data)) {
    if (data.length === 0) return `type ${name} = unknown[];`;
    const itemName = name.replace(/Response$/, 'Item');
    const itemDef = generateTypeScript(data[0], itemName, depth + 1);
    return `${itemDef}\n\ntype ${name} = ${itemName}[];`;
  }
  const keys = Object.keys(data as Record<string, unknown>);
  if (keys.length === 0) return `type ${name} = Record<string, unknown>;`;

  let result = `interface ${name} {\n`;
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    let tsType: string;
    if (value === null) tsType = 'null';
    else if (typeof value === 'string') tsType = 'string';
    else if (typeof value === 'number') tsType = 'number';
    else if (typeof value === 'boolean') tsType = 'boolean';
    else if (Array.isArray(value)) {
      if (value.length === 0) tsType = 'unknown[]';
      else if (typeof value[0] === 'object' && value[0] !== null)
        tsType = `${name}${key.charAt(0).toUpperCase() + key.slice(1)}Item[]`;
      else tsType = `${typeof value[0]}[]`;
    } else if (typeof value === 'object') {
      tsType = `${name}${key.charAt(0).toUpperCase() + key.slice(1)}`;
    } else {
      tsType = 'unknown';
    }
    result += `  ${key}: ${tsType};\n`;
  }
  result += `}`;
  return result;
}

function generateReport(
  results: ProbeResult[],
  jsAnalysis: { url: string; patterns: string[] }[],
  inlineApiPatterns: string[],
  scriptUrls: string[],
  errors: { context: string; error: string }[]
): string {
  const now = new Date().toISOString();
  const successfulPages = results.filter(
    (r) => r.status >= 200 && r.status < 400 && r.contentType?.includes('html') && !r.botBlocked
  );
  const successfulApi = results.filter(
    (r) =>
      r.status >= 200 &&
      r.status < 400 &&
      (r.contentType?.includes('json') || r.contentType?.includes('xml')) &&
      !r.botBlocked
  );
  const botBlocked = results.filter((r) => r.botBlocked);
  const authRedirects = results.filter(
    (r) =>
      r.redirectedTo?.toLowerCase().includes('login') ||
      r.redirectedTo?.toLowerCase().includes('signin')
  );
  const notFound = results.filter((r) => r.status === 404);
  const serverErrors = results.filter((r) => r.status >= 500);
  const failed = results.filter((r) => r.error);

  let report = `# Live Discovery Report (fetch-based)

**Generated:** ${now}
**Base URL:** \`${BASE_URL}\`
**Host Filter:** \`${HOST_FILTER || '(none)'}\`
**Method:** Node.js native fetch with stored session cookies

> Note: Bot detection may block some requests. Use \`npm run live-discover\` (Playwright) for sites with strict bot protection.

---

## Summary

| Category | Count |
|----------|-------|
| Total requests | ${results.length} |
| Successful page loads | ${successfulPages.length} |
| Successful API responses | ${successfulApi.length} |
| Bot-blocked | ${botBlocked.length} |
| Auth redirects | ${authRedirects.length} |
| 404 Not Found | ${notFound.length} |
| Server errors (5xx) | ${serverErrors.length} |
| Network failures | ${failed.length} |

---

## Confirmed Endpoints

`;

  if (successfulPages.length > 0) {
    report += `### Accessible Pages\n\n| # | URL | Status | Notes |\n|---|-----|--------|-------|\n`;
    let i = 1;
    for (const r of successfulPages) {
      const shortUrl = r.url.replace(BASE_URL, '');
      const notes = r.redirectedTo ? `Redirected from: ${r.redirectedTo.replace(BASE_URL, '')}` : '';
      report += `| ${i} | \`${shortUrl}\` | ${r.status} | ${notes} |\n`;
      i++;
    }
    report += `\n`;
  }

  if (successfulApi.length > 0) {
    report += `### API Endpoints\n\n| # | URL | Status | Content-Type | Response Shape |\n|---|-----|--------|-------------|----------------|\n`;
    let i = 1;
    for (const r of successfulApi) {
      const shortUrl = r.url.replace(BASE_URL, '');
      let shape = 'N/A';
      if (r.body && r.contentType.includes('json')) {
        try {
          const parsed = JSON.parse(r.body);
          if (Array.isArray(parsed)) shape = `Array[${parsed.length}]`;
          else if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            shape = keys.length <= 5 ? `{${keys.join(', ')}}` : `Object(${keys.length} keys)`;
          }
        } catch { /* ignore */ }
      }
      report += `| ${i} | \`${shortUrl}\` | ${r.status} | ${r.contentType.split(';')[0]} | ${shape} |\n`;
      i++;
    }
    report += `\n`;
  }

  report += `---\n\n## Response Details\n\n`;
  for (const r of successfulApi) {
    if (r.body) {
      const shortUrl = r.url.replace(BASE_URL, '');
      report += `### \`GET ${shortUrl}\`\n\n**Status:** ${r.status}\n**Content-Type:** ${r.contentType}\n\n`;
      if (r.contentType.includes('json')) {
        try {
          const parsed = JSON.parse(r.body);
          report += `\`\`\`json\n${JSON.stringify(parsed, null, 2).substring(0, 5000)}\n\`\`\`\n`;
        } catch {
          report += `\`\`\`\n${r.body.substring(0, 2000)}\n\`\`\`\n`;
        }
      } else {
        report += `\`\`\`\n${r.body.substring(0, 2000)}\n\`\`\`\n`;
      }
      report += `\n`;
    }
  }

  report += `---\n\n## TypeScript Interfaces\n\n`;
  for (const r of successfulApi) {
    if (r.body && r.contentType.includes('json')) {
      try {
        const parsed = JSON.parse(r.body);
        const shortUrl = r.url.replace(BASE_URL, '').split('?')[0];
        const name = urlToInterfaceName(shortUrl);
        report += `### From \`${shortUrl}\`\n\n\`\`\`typescript\n${generateTypeScript(parsed, name)}\n\`\`\`\n\n`;
      } catch { /* skip */ }
    }
  }

  report += `---\n\n## JS Bundle Analysis\n\n`;
  const ccScripts = scriptUrls.filter((u) => !HOST_FILTER || u.includes(HOST_FILTER));
  report += `**Target scripts (${ccScripts.length}):**\n`;
  for (const s of [...new Set(ccScripts)]) {
    report += `- \`${s.replace(BASE_URL, '')}\`\n`;
  }
  if (jsAnalysis.length > 0) {
    report += `\n### API Patterns in JS Bundles\n\n`;
    for (const { url, patterns } of jsAnalysis) {
      report += `**\`${url.replace(BASE_URL, '')}\`:**\n`;
      for (const p of patterns) report += `- \`${p}\`\n`;
      report += `\n`;
    }
  }

  if (botBlocked.length > 0) {
    report += `---\n\n## Bot-Blocked Requests\n\nThe following were blocked by bot detection.\n`;
    report += `Use \`npm run live-discover\` (Playwright) for these.\n\n`;
    for (const r of botBlocked) {
      report += `- \`${r.url.replace(BASE_URL, '')}\` (${r.status})\n`;
    }
    report += `\n`;
  }

  if (errors.length > 0) {
    report += `---\n\n## Errors\n\n`;
    for (const e of errors) {
      report += `- **${e.context}:** ${e.error}\n`;
    }
    report += `\n`;
  }

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== Live Discovery (fetch-based) ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Host filter: ${HOST_FILTER || '(none)'}`);

  const storageState = loadStorageState();
  const cookieHeader = buildCookieHeader(storageState);

  console.log(`Loaded ${storageState.cookies.length} cookies from storage state`);

  // Check if any JWT-like cookies are expired
  for (const cookie of storageState.cookies) {
    if (cookie.expires > 0 && cookie.expires < Date.now() / 1000) {
      console.log(`  WARNING: Cookie "${cookie.name}" expired at ${new Date(cookie.expires * 1000).toISOString()}`);
    }
    // Try to decode JWT payload
    const parts = cookie.value.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString()) as Record<string, unknown>;
        if (typeof payload.exp === 'number') {
          const expiry = new Date(payload.exp * 1000);
          const remaining = Math.round((expiry.getTime() - Date.now()) / 1000);
          console.log(`  Cookie "${cookie.name}" JWT exp: ${expiry.toISOString()} (${remaining}s from now)`);
          if (remaining < 0) {
            console.log(`    WARNING: JWT has expired!`);
          }
        }
      } catch { /* not a JWT */ }
    }
  }

  const results: ProbeResult[] = [];
  const allErrors: { context: string; error: string }[] = [];

  // Phase 1: Page navigation
  if (PAGES_TO_VISIT.length > 0) {
    console.log('\n--- Phase 1: Page Navigation ---');
    for (const page of PAGES_TO_VISIT) {
      const result = await probeDocument(page, cookieHeader);
      results.push(result);
      if (result.botBlocked) {
        console.log(`\nBot detection triggered on ${page}. Consider using Playwright instead.`);
        allErrors.push({ context: page, error: 'Bot detection challenge' });
        break;
      }
      if (result.status === 429) {
        console.log(`\nRate limited (429). Stopping.`);
        break;
      }
      await sleep(DELAY_MS);
    }
  }

  // Phase 2: Extract script URLs and inline patterns from HTML responses
  console.log('\n--- Phase 2: HTML Analysis ---');
  const scriptUrls: string[] = [];
  const inlineApiPatterns: string[] = [];

  for (const result of results) {
    if (result.body && result.contentType?.includes('html') && !result.botBlocked) {
      const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
      let match;
      while ((match = scriptRegex.exec(result.body)) !== null) {
        const src = match[1];
        if (!HOST_FILTER || src.includes(HOST_FILTER) || src.startsWith('/')) {
          scriptUrls.push(src.startsWith('/') ? `${BASE_URL}${src}` : src);
        }
      }

      const inlineRegex = /<script[^>]*>([^<]*(?:api|fetch|ajax|\.get|\.post)[^<]*)<\/script>/gi;
      while ((match = inlineRegex.exec(result.body)) !== null) {
        inlineApiPatterns.push(match[1].trim());
      }
    }
  }

  console.log(`Found ${scriptUrls.length} script URLs, ${inlineApiPatterns.length} inline patterns`);

  // Phase 3: Fetch JS bundles
  console.log('\n--- Phase 3: JS Bundle Analysis ---');
  const uniqueScriptUrls = [...new Set(scriptUrls)];
  const jsAnalysis: { url: string; patterns: string[] }[] = [];

  for (const url of uniqueScriptUrls.slice(0, 20)) {
    const result = await probeDocument(url, cookieHeader);
    results.push(result);
    if (result.body && !result.botBlocked) {
      const patterns = extractApiPatterns(result.body);
      if (patterns.length > 0) {
        jsAnalysis.push({ url, patterns });
        console.log(`    Found ${patterns.length} patterns in ${url}`);
      }
    }
    if (result.botBlocked) break;
    await sleep(DELAY_MS);
  }

  // Phase 4: Probe API-like endpoints found in JS
  const discoveredPaths = new Set<string>();
  for (const { patterns } of jsAnalysis) {
    for (const p of patterns) {
      if (p.startsWith('/') && (p.includes('/api/') || p.includes('/v'))) {
        discoveredPaths.add(p);
      }
    }
  }

  if (discoveredPaths.size > 0) {
    console.log(`\n--- Phase 4: API Endpoint Probing (${discoveredPaths.size} paths) ---`);
    for (const p of discoveredPaths) {
      const result = await probeXhr(p, cookieHeader);
      results.push(result);
      if (result.botBlocked) break;
      if (result.status === 429) break;
      await sleep(DELAY_MS);
    }
  }

  // Generate report
  console.log('\n--- Generating Report ---');
  const report = generateReport(results, jsAnalysis, inlineApiPatterns, scriptUrls, allErrors);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, 'live-discovery-fetch.md');
  fs.writeFileSync(reportPath, report);
  console.log(`Report: ${reportPath}`);

  const rawPath = path.join(OUTPUT_DIR, 'live-discovery-fetch-raw.json');
  fs.writeFileSync(
    rawPath,
    JSON.stringify(
      {
        results,
        jsAnalysis,
        inlineApiPatterns,
        scriptUrls,
        errors: allErrors,
        timestamp: new Date().toISOString(),
        baseUrl: BASE_URL,
        hostFilter: HOST_FILTER,
      },
      null,
      2
    )
  );
  console.log(`Raw data: ${rawPath}`);
  console.log(`\nDone at ${new Date().toISOString()}`);
}

main().catch(console.error);
