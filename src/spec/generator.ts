/**
 * src/spec/generator.ts — Generate a draft spec from capture output
 *
 * Reads a capture directory (traffic.json + screenshots/ + optional console.json)
 * and produces a draft YAML spec that a human can refine.
 *
 * Usage:
 *   npx tsx src/spec/generator.ts                          # auto-finds latest capture
 *   npx tsx src/spec/generator.ts --input captures/2024-01-01_12-00-00
 *   npx tsx src/spec/generator.ts --input captures/latest --output spec.yaml
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  Spec,
  PageSpec,
  ExpectedRequest,
  ExpectedResponse,
  ConsoleExpectation,
  JsonSchema,
  SpecV2,
  Area,
  Behavior,
} from './types.js';
import type { CapturedTraffic, CapturedConsoleEntry } from '../capture/types.js';
import { specToYaml } from './parser.js';
import { smartGenerate } from './smart-generator.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { inputDir: string; outputFile: string; specName: string } {
  const args = process.argv.slice(2);
  let inputDir = '';
  let outputFile = '';
  let specName = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputDir = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputFile = args[++i];
    } else if (args[i] === '--name' && args[i + 1]) {
      specName = args[++i];
    }
  }

  // Auto-find latest capture directory
  if (!inputDir) {
    inputDir = findLatestCapture();
  }

  if (!outputFile) {
    outputFile = path.join(path.dirname(inputDir), 'spec.yaml');
  }

  if (!specName) {
    specName = 'Generated Spec';
  }

  return { inputDir: path.resolve(inputDir), outputFile: path.resolve(outputFile), specName };
}

function findLatestCapture(): string {
  const envDir = process.env.CAPTURE_OUTPUT_DIR;
  const candidates = envDir ? [envDir] : ['.specify/capture', 'captures'];
  const capturesDir = path.resolve(candidates.find(d => fs.existsSync(path.resolve(d))) ?? candidates[0]);

  if (!fs.existsSync(capturesDir)) {
    console.error(`Captures directory not found. Checked: ${candidates.join(', ')}`);
    console.error('Run "specify capture --url <url>" first, or use --input <dir>');
    process.exit(1);
  }

  // Look for timestamped subdirectories
  const subdirs = fs.readdirSync(capturesDir)
    .filter((d) => {
      const full = path.join(capturesDir, d);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'traffic.json'));
    })
    .sort()
    .reverse();

  if (subdirs.length > 0) {
    return path.join(capturesDir, subdirs[0]);
  }

  // Fall back to captures/ itself if it has traffic.json
  if (fs.existsSync(path.join(capturesDir, 'traffic.json'))) {
    return capturesDir;
  }

  console.error(`No capture data found in ${capturesDir}`);
  console.error('Run "npm run browse" or "npm run capture" first, or use --input <dir>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Capture loading
// ---------------------------------------------------------------------------

function loadTraffic(dir: string): CapturedTraffic[] {
  const trafficPath = path.join(dir, 'traffic.json');
  if (!fs.existsSync(trafficPath)) {
    console.error(`traffic.json not found in ${dir}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(trafficPath, 'utf-8');
  return JSON.parse(raw) as CapturedTraffic[];
}

function loadConsole(dir: string): CapturedConsoleEntry[] {
  const consolePath = path.join(dir, 'console.json');
  if (!fs.existsSync(consolePath)) {
    return [];
  }
  const raw = fs.readFileSync(consolePath, 'utf-8');
  return JSON.parse(raw) as CapturedConsoleEntry[];
}

function loadScreenshots(dir: string): string[] {
  const screenshotDir = path.join(dir, 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    return [];
  }
  return fs.readdirSync(screenshotDir)
    .filter((f) => f.endsWith('.png'))
    .sort();
}

// ---------------------------------------------------------------------------
// URL / path utilities
// ---------------------------------------------------------------------------

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function extractOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Convert a URL path to a slug suitable for a page ID. */
function pathToId(urlPath: string): string {
  return urlPath
    .replace(/^\//, '')
    .replace(/[\/\?&#=.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    || 'root';
}

/** Derive a page path from a screenshot filename. */
function screenshotToPath(filename: string): string | null {
  // Format: "001-some_slug.png" -> "/some/slug"
  const match = filename.match(/^\d+-(.+)\.png$/);
  if (!match) return null;

  const slug = match[1];
  if (slug === 'final-state') return null;

  return '/' + slug.replace(/_/g, '/');
}

// ---------------------------------------------------------------------------
// JSON Schema inference from a response body
// ---------------------------------------------------------------------------

function inferSchema(value: unknown): JsonSchema {
  if (value === null || value === undefined) {
    return {};
  }

  if (Array.isArray(value)) {
    const schema: JsonSchema = { type: 'array' };
    if (value.length > 0) {
      schema.items = inferSchema(value[0]);
    }
    return schema;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    const keys = Object.keys(obj);

    for (const key of keys) {
      properties[key] = inferSchema(obj[key]);
    }

    return {
      type: 'object',
      required: keys,
      properties,
    };
  }

  if (typeof value === 'number') {
    return { type: 'number' };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }

  return { type: 'string' };
}

function tryInferBodySchema(body: string | null): JsonSchema | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return inferSchema(parsed);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Grouping traffic by page
// ---------------------------------------------------------------------------

interface PageGroup {
  pagePath: string;
  requests: CapturedTraffic[];
}

function groupByPage(traffic: CapturedTraffic[]): PageGroup[] {
  // Group requests by URL path — each unique API path prefix becomes a page
  const pathToRequests = new Map<string, CapturedTraffic[]>();

  for (const entry of traffic) {
    const urlPath = extractPath(entry.url);

    // Determine which "page" this request belongs to.
    // Heuristic: if the request is to /api/xxx/yyy, the page is probably /xxx
    const segments = urlPath.split('/').filter(Boolean);

    let pagePath: string;
    if (segments[0] === 'api' && segments.length >= 2) {
      // API request: group under the first non-api segment
      pagePath = '/' + segments[1];
    } else if (segments.length > 0) {
      pagePath = '/' + segments[0];
    } else {
      pagePath = '/';
    }

    const existing = pathToRequests.get(pagePath);
    if (existing) {
      existing.push(entry);
    } else {
      pathToRequests.set(pagePath, [entry]);
    }
  }

  return Array.from(pathToRequests.entries())
    .map(([pagePath, requests]) => ({ pagePath, requests }))
    .sort((a, b) => a.pagePath.localeCompare(b.pagePath));
}

// ---------------------------------------------------------------------------
// Generate expected_requests from traffic
// ---------------------------------------------------------------------------

function deduplicateRequests(requests: CapturedTraffic[]): CapturedTraffic[] {
  // Keep one representative per unique (method, path) combination
  const seen = new Map<string, CapturedTraffic>();
  for (const req of requests) {
    const key = `${req.method} ${extractPath(req.url)}`;
    if (!seen.has(key)) {
      seen.set(key, req);
    }
  }
  return Array.from(seen.values());
}

function buildExpectedRequest(entry: CapturedTraffic, origin: string): ExpectedRequest {
  const urlPath = extractPath(entry.url);
  // Make url_pattern relative (strip origin)
  const urlPattern = urlPath;

  const expectedReq: ExpectedRequest = {
    method: entry.method,
    url_pattern: urlPattern,
  };

  const response: ExpectedResponse = {};
  let hasResponse = false;

  if (entry.status) {
    response.status = entry.status;
    hasResponse = true;
  }

  if (entry.contentType) {
    const ct = entry.contentType.split(';')[0].trim();
    if (ct) {
      response.content_type = ct;
      hasResponse = true;
    }
  }

  const bodySchema = tryInferBodySchema(entry.responseBody);
  if (bodySchema) {
    response.body_schema = bodySchema;
    hasResponse = true;
  }

  if (hasResponse) {
    expectedReq.response = response;
  }

  // Tag with confidence: assertions derived from captured traffic are "observed"
  expectedReq.confidence = 'observed';

  return expectedReq;
}

// ---------------------------------------------------------------------------
// Generate console expectations
// ---------------------------------------------------------------------------

function buildConsoleExpectations(
  consoleLogs: CapturedConsoleEntry[],
): ConsoleExpectation[] {
  const levelCounts = new Map<string, number>();
  for (const entry of consoleLogs) {
    const level = entry.type;
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  }

  const expectations: ConsoleExpectation[] = [];

  // Always assert no console errors
  expectations.push({
    level: 'error',
    count: levelCounts.get('error') ?? 0,
  });

  // If there were warnings, note them
  const warnCount = levelCounts.get('warning') ?? levelCounts.get('warn') ?? 0;
  if (warnCount > 0) {
    expectations.push({
      level: 'warn',
      count: warnCount,
    });
  }

  return expectations;
}

// ---------------------------------------------------------------------------
// Build pages from screenshots + traffic
// ---------------------------------------------------------------------------

function buildPagesFromScreenshots(
  screenshots: string[],
  pageGroups: PageGroup[],
  consoleLogs: CapturedConsoleEntry[],
  origin: string,
): PageSpec[] {
  const pages: PageSpec[] = [];
  const seenIds = new Set<string>();

  // First, create pages from traffic groups
  for (const group of pageGroups) {
    const id = pathToId(group.pagePath);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const unique = deduplicateRequests(group.requests);
    const expectedRequests = unique.map((r) => buildExpectedRequest(r, origin));

    const page: PageSpec = {
      id,
      path: group.pagePath,
      expected_requests: expectedRequests,
      console_expectations: buildConsoleExpectations(consoleLogs),
    };

    pages.push(page);
  }

  // Then, add pages discovered from screenshots that weren't in traffic
  for (const screenshot of screenshots) {
    const derivedPath = screenshotToPath(screenshot);
    if (!derivedPath) continue;

    const id = pathToId(derivedPath);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const page: PageSpec = {
      id,
      path: derivedPath,
      visual_assertions: [
        {
          type: 'screenshot_region' as const,
          selector: 'body',
          description: `Page renders correctly (from ${screenshot})`,
        },
      ],
      console_expectations: [
        { level: 'error', count: 0 },
      ],
    };

    pages.push(page);
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Core spec generation logic — importable from CLI commands
// ---------------------------------------------------------------------------

/** Core spec generation logic — importable from CLI commands. */
export function generateSpec(options: { inputDir: string; specName: string; smart?: boolean }): Spec {
  const traffic = loadTraffic(options.inputDir);
  const consoleLogs = loadConsole(options.inputDir);

  if (options.smart) {
    return smartGenerate({
      inputDir: options.inputDir,
      specName: options.specName,
      traffic,
      consoleLogs,
    });
  }

  const screenshots = loadScreenshots(options.inputDir);
  const origin = traffic.length > 0 ? extractOrigin(traffic[0].url) : '';
  const pageGroups = groupByPage(traffic);
  const pages = buildPagesFromScreenshots(screenshots, pageGroups, consoleLogs, origin);

  return {
    version: '1.0',
    name: options.specName,
    description: `Generated from capture: ${path.basename(options.inputDir)}`,
    pages,
    variables: {
      base_url: origin || '${TARGET_BASE_URL}',
    },
  };
}

// ---------------------------------------------------------------------------
// V2 spec generation — behavioral claims instead of matchers
// ---------------------------------------------------------------------------

/** Generate a v2 behavioral spec from capture data. */
export function generateSpecV2(options: { inputDir: string; specName: string }): SpecV2 {
  const traffic = loadTraffic(options.inputDir);
  const consoleLogs = loadConsole(options.inputDir);
  const origin = traffic.length > 0 ? extractOrigin(traffic[0].url) : '';
  const pageGroups = groupByPage(traffic);

  const areas: Area[] = [];

  for (const group of pageGroups) {
    const areaId = pathToId(group.pagePath);
    const unique = deduplicateRequests(group.requests);
    const behaviors: Behavior[] = [];

    for (const req of unique) {
      const urlPath = extractPath(req.url);
      behaviors.push({
        id: pathToId(`${req.method.toLowerCase()}-${urlPath}`),
        description: `${req.method} ${urlPath} returns ${req.status}`,
        ...(req.contentType?.includes('json') ? { tags: ['api'] } : {}),
      });
    }

    if (behaviors.length > 0) {
      areas.push({
        id: areaId,
        name: group.pagePath === '/' ? 'Root' : group.pagePath.replace(/^\//, ''),
        behaviors: deduplicateBehaviors(behaviors),
      });
    }
  }

  // Add a general behaviors area for console/error expectations
  const errorCount = consoleLogs.filter((e) => e.type === 'error').length;
  if (errorCount === 0) {
    const generalBehaviors: Behavior[] = [
      { id: 'no-console-errors', description: 'No console errors appear during normal usage' },
    ];
    areas.push({ id: 'reliability', name: 'Reliability', behaviors: generalBehaviors });
  }

  if (areas.length === 0) {
    areas.push({
      id: 'general',
      name: 'General',
      behaviors: [{ id: 'app-loads', description: 'Application loads without errors' }],
    });
  }

  return {
    version: '2',
    name: options.specName,
    description: `Generated from capture: ${path.basename(options.inputDir)}`,
    target: { type: 'web', url: origin || '${TARGET_URL}' },
    areas,
    variables: {
      base_url: origin || '${TARGET_BASE_URL}',
    },
  };
}

function deduplicateBehaviors(behaviors: Behavior[]): Behavior[] {
  const seen = new Set<string>();
  const result: Behavior[] = [];
  for (const b of behaviors) {
    let id = b.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${b.id}-${suffix++}`;
    }
    seen.add(id);
    result.push({ ...b, id });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function generate(): void {
  const { inputDir, outputFile, specName } = parseArgs();

  console.log(`Reading capture data from: ${inputDir}`);

  const traffic = loadTraffic(inputDir);
  const consoleLogs = loadConsole(inputDir);
  const screenshots = loadScreenshots(inputDir);

  console.log(`  Traffic entries: ${traffic.length}`);
  console.log(`  Console entries: ${consoleLogs.length}`);
  console.log(`  Screenshots: ${screenshots.length}`);

  // Determine origin from the first traffic entry
  const origin = traffic.length > 0 ? extractOrigin(traffic[0].url) : '';

  // Group traffic by page
  const pageGroups = groupByPage(traffic);
  console.log(`  Page groups: ${pageGroups.length}`);

  // Build pages
  const pages = buildPagesFromScreenshots(screenshots, pageGroups, consoleLogs, origin);

  // Assemble the spec
  const spec: Spec = {
    version: '1.0',
    name: specName,
    description: `Generated from capture: ${path.basename(inputDir)}`,
    pages,
    variables: {
      base_url: origin || '${TARGET_BASE_URL}',
    },
  };

  // Write output
  const yamlContent = specToYaml(spec);
  const dir = path.dirname(outputFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputFile, yamlContent, 'utf-8');

  console.log(`\nSpec written to: ${outputFile}`);
  console.log(`  Pages: ${pages.length}`);
  console.log(`  Total expected requests: ${pages.reduce((n, p) => n + (p.expected_requests?.length ?? 0), 0)}`);
  console.log('\nReview and refine the generated spec before using it for validation.');
}

// Only run as a standalone CLI script, not when imported as a module
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate();
}
