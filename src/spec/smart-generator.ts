/**
 * src/spec/smart-generator.ts — Smart spec generation
 *
 * Enhanced generation that infers page groupings semantically,
 * detects navigation flows, and generates interaction scenarios
 * from observed traffic patterns.
 */

import * as path from 'path';
import type {
  Spec,
  PageSpec,
  ExpectedRequest,
  FlowSpec,
  FlowStep,
  ScenarioSpec,
  ScenarioStep,
  ConsoleExpectation,
} from './types.js';
import type { CapturedTraffic, CapturedConsoleEntry } from '../capture/types.js';

interface SmartGeneratorInput {
  inputDir: string;
  specName: string;
  traffic: CapturedTraffic[];
  consoleLogs: CapturedConsoleEntry[];
}

/** Generate a spec with smart grouping, flow inference, and scenario detection. */
export function smartGenerate(input: SmartGeneratorInput): Spec {
  const { traffic, consoleLogs, specName, inputDir } = input;

  // 1. Semantic page grouping: HTML documents define pages
  const pages = groupPagesSemanticly(traffic);

  // 2. Flow inference: ordered document navigations → FlowSpec
  const flows = inferFlows(traffic);

  // 3. Scenario inference: POST/PUT following GET → fill + click + wait
  for (const page of pages) {
    const scenarios = inferScenarios(page, traffic);
    if (scenarios.length > 0) {
      page.scenarios = scenarios;
    }
  }

  // 4. Console expectations
  for (const page of pages) {
    page.console_expectations = buildSmartConsoleExpectations(consoleLogs);
  }

  // 5. Add descriptions to assertions
  for (const page of pages) {
    for (const req of page.expected_requests ?? []) {
      if (!req.description) {
        req.description = generateRequestDescription(req);
      }
      // Smart-generated assertions get observed confidence
      req.confidence = 'observed';
    }
  }

  const origin = traffic.length > 0 ? extractOrigin(traffic[0].url) : '';

  return {
    version: '1.0',
    name: specName,
    description: `Smart-generated from capture: ${path.basename(inputDir)}`,
    pages,
    flows: flows.length > 0 ? flows : undefined,
    variables: {
      base_url: origin || '${TARGET_BASE_URL}',
    },
    defaults: {
      no_5xx: true,
      no_console_errors: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Semantic page grouping
// ---------------------------------------------------------------------------

function groupPagesSemanticly(traffic: CapturedTraffic[]): PageSpec[] {
  const documentRequests: CapturedTraffic[] = [];
  const apiRequests: CapturedTraffic[] = [];

  for (const entry of traffic) {
    const ct = (entry.contentType ?? '').toLowerCase();
    if (ct.includes('text/html') && entry.method.toUpperCase() === 'GET') {
      documentRequests.push(entry);
    } else {
      apiRequests.push(entry);
    }
  }

  // Each document request defines a page
  const pages: PageSpec[] = [];
  const seenPaths = new Set<string>();

  // Sort by timestamp
  const sorted = [...documentRequests].sort((a, b) => a.ts - b.ts);

  for (const doc of sorted) {
    const pagePath = extractPath(doc.url);
    if (seenPaths.has(pagePath)) continue;
    seenPaths.add(pagePath);

    const pageId = pathToId(pagePath);

    // Find API requests temporally close to this document (within 5s after)
    const relatedApi = apiRequests.filter(
      (api) => api.ts >= doc.ts && api.ts <= doc.ts + 5000,
    );

    // Deduplicate by method+path
    const seen = new Set<string>();
    const expectedRequests: ExpectedRequest[] = [];

    for (const api of relatedApi) {
      const key = `${api.method.toUpperCase()} ${extractPath(api.url)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      expectedRequests.push(buildExpectedRequest(api));
    }

    pages.push({
      id: pageId,
      path: pagePath,
      expected_requests: expectedRequests.length > 0 ? expectedRequests : undefined,
    });
  }

  // If no document requests found, fall back to simple grouping
  if (pages.length === 0) {
    return fallbackGrouping(traffic);
  }

  return pages;
}

function fallbackGrouping(traffic: CapturedTraffic[]): PageSpec[] {
  const groups = new Map<string, CapturedTraffic[]>();
  for (const entry of traffic) {
    const segments = extractPath(entry.url).split('/').filter(Boolean);
    const pagePath = segments.length > 0 ? '/' + segments[0] : '/';
    const existing = groups.get(pagePath) ?? [];
    existing.push(entry);
    groups.set(pagePath, existing);
  }

  return Array.from(groups.entries()).map(([pagePath, entries]) => {
    const seen = new Set<string>();
    const requests: ExpectedRequest[] = [];
    for (const e of entries) {
      const key = `${e.method.toUpperCase()} ${extractPath(e.url)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push(buildExpectedRequest(e));
    }
    return {
      id: pathToId(pagePath),
      path: pagePath,
      expected_requests: requests,
    };
  });
}

// ---------------------------------------------------------------------------
// Flow inference
// ---------------------------------------------------------------------------

function inferFlows(traffic: CapturedTraffic[]): FlowSpec[] {
  // Find document navigations in order
  const navigations = traffic
    .filter(
      (t) =>
        t.method.toUpperCase() === 'GET' &&
        (t.contentType ?? '').toLowerCase().includes('text/html'),
    )
    .sort((a, b) => a.ts - b.ts);

  // Deduplicate consecutive same-path navigations
  const uniqueNavs: CapturedTraffic[] = [];
  for (const nav of navigations) {
    const prevPath = uniqueNavs.length > 0 ? extractPath(uniqueNavs[uniqueNavs.length - 1].url) : null;
    if (extractPath(nav.url) !== prevPath) {
      uniqueNavs.push(nav);
    }
  }

  // Only create a flow if there are 2+ navigations
  if (uniqueNavs.length < 2) return [];

  const steps: FlowStep[] = uniqueNavs.map((nav) => ({
    navigate: extractPath(nav.url),
    description: `Navigate to ${extractPath(nav.url)}`,
  }));

  return [
    {
      id: 'main-flow',
      description: 'Primary navigation flow inferred from capture',
      steps,
    },
  ];
}

// ---------------------------------------------------------------------------
// Scenario inference
// ---------------------------------------------------------------------------

function inferScenarios(page: PageSpec, traffic: CapturedTraffic[]): ScenarioSpec[] {
  const pagePath = page.path;

  // Find POST/PUT requests that follow a GET to the same page path area
  const sortedTraffic = [...traffic].sort((a, b) => a.ts - b.ts);

  const scenarios: ScenarioSpec[] = [];

  // Look for form submission patterns: GET page → POST/PUT to related endpoint
  const mutations = sortedTraffic.filter(
    (t) =>
      ['POST', 'PUT', 'PATCH'].includes(t.method.toUpperCase()) &&
      isRelatedPath(extractPath(t.url), pagePath),
  );

  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    const steps: ScenarioStep[] = [];

    // If there's a POST body, infer fill steps
    if (mutation.postData) {
      try {
        const body = JSON.parse(mutation.postData);
        if (typeof body === 'object' && body !== null) {
          for (const [key, value] of Object.entries(body)) {
            if (typeof value === 'string' || typeof value === 'number') {
              steps.push({
                action: 'fill',
                selector: `[name="${key}"], #${key}, input[placeholder*="${key}" i]`,
                value: String(value),
                description: `Fill ${key} field`,
              });
            }
          }
        }
      } catch {
        // Not JSON — skip fill inference
      }
    }

    // Add a submit click
    steps.push({
      action: 'click',
      selector: 'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Save")',
      description: `Submit form to ${extractPath(mutation.url)}`,
    });

    // Wait for the request
    steps.push({
      action: 'wait_for_request',
      url_pattern: extractPath(mutation.url),
      method: mutation.method.toUpperCase(),
      description: `Wait for ${mutation.method.toUpperCase()} ${extractPath(mutation.url)}`,
    });

    scenarios.push({
      id: `${page.id}-submit-${i}`,
      description: `Form submission to ${extractPath(mutation.url)}`,
      steps,
    });
  }

  return scenarios;
}

function isRelatedPath(apiPath: string, pagePath: string): boolean {
  // Check if the API path is "related" to the page path
  // e.g., /api/users is related to /users
  const apiSegments = apiPath.split('/').filter(Boolean);
  const pageSegments = pagePath.split('/').filter(Boolean);

  if (pageSegments.length === 0) return true; // Root page relates to everything

  // Check if any page segment appears in the API path
  return pageSegments.some((seg) => apiSegments.includes(seg));
}

// ---------------------------------------------------------------------------
// Helpers
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

function pathToId(urlPath: string): string {
  return (
    urlPath
      .replace(/^\//, '')
      .replace(/[\/\?&#=.]/g, '-')
      .replace(/-+/g, '-')
      .replace(/-$/, '') || 'root'
  );
}

function buildExpectedRequest(entry: CapturedTraffic): ExpectedRequest {
  const req: ExpectedRequest = {
    method: entry.method.toUpperCase(),
    url_pattern: extractPath(entry.url),
  };

  if (entry.status) {
    req.response = { status: entry.status };
    if (entry.contentType) {
      const ct = entry.contentType.split(';')[0].trim();
      if (ct) req.response.content_type = ct;
    }
  }

  return req;
}

function buildSmartConsoleExpectations(consoleLogs: CapturedConsoleEntry[]): ConsoleExpectation[] {
  const errorCount = consoleLogs.filter((e) => e.type === 'error').length;
  return [{ level: 'error', count: errorCount }];
}

function generateRequestDescription(req: ExpectedRequest): string {
  const verb = req.method.toUpperCase();
  const urlPath = req.url_pattern;

  if (verb === 'GET') return `Fetch data from ${urlPath}`;
  if (verb === 'POST') return `Submit data to ${urlPath}`;
  if (verb === 'PUT' || verb === 'PATCH') return `Update data at ${urlPath}`;
  if (verb === 'DELETE') return `Remove data at ${urlPath}`;
  return `${verb} request to ${urlPath}`;
}
