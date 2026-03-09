/**
 * src/validation/validator.ts — Validation engine
 *
 * Matches a parsed spec against a capture session and produces a GapReport.
 * This is best-effort passive analysis: we compare spec requirements against
 * traffic that was already captured, not actively executed.
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import type { Spec, PageSpec, ExpectedRequest, FlowSpec, FlowStep } from '../spec/types.js';
import type {
  CapturedTraffic,
  CapturedConsoleEntry,
  CaptureManifest,
} from '../capture/types.js';
import type {
  GapReport,
  PageResult,
  RequestResult,
  AssertionResult,
  ConsoleResult,
  ScenarioResult,
  StepResult,
  FlowResult,
  FlowStepResult,
  CheckStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// URL pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a captured URL against a spec url_pattern.
 * Supports:
 *   - Exact path matching ("/api/users")
 *   - Glob wildcards ("/api/users/*")
 *   - Regex (when pattern starts with "^")
 */
function matchUrlPattern(capturedUrl: string, pattern: string): boolean {
  // Regex pattern
  if (pattern.startsWith('^')) {
    try {
      const re = new RegExp(pattern);
      // Match against pathname only or full URL
      const url = new URL(capturedUrl, 'http://localhost');
      return re.test(url.pathname) || re.test(capturedUrl);
    } catch {
      return false;
    }
  }

  // Extract pathname from captured URL for comparison
  let capturedPath: string;
  try {
    capturedPath = new URL(capturedUrl, 'http://localhost').pathname;
  } catch {
    capturedPath = capturedUrl;
  }

  // Glob wildcard matching
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\*\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return re.test(capturedPath) || re.test(capturedUrl);
  }

  // Exact match (path only or substring of full URL)
  return capturedPath === pattern || capturedUrl.includes(pattern);
}

/**
 * Match a URL pattern against a page path for navigation detection.
 * More lenient — checks if the captured URL contains the expected path.
 */
function urlMatchesPagePath(capturedUrl: string, pagePath: string): boolean {
  // Strip dynamic segments (:id) for comparison
  const normalizedPath = pagePath.replace(/:[^/]+/g, '[^/]+');
  if (normalizedPath !== pagePath) {
    try {
      const re = new RegExp(normalizedPath);
      const url = new URL(capturedUrl, 'http://localhost');
      return re.test(url.pathname);
    } catch {
      // fall through
    }
  }

  try {
    const url = new URL(capturedUrl, 'http://localhost');
    return url.pathname === pagePath || url.pathname.startsWith(pagePath);
  } catch {
    return capturedUrl.includes(pagePath);
  }
}

// ---------------------------------------------------------------------------
// JSON Schema validation for response bodies
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true });

function validateBodySchema(
  body: string | null | undefined,
  schema: object,
): { valid: boolean; errors: string[] } {
  if (!body) {
    return { valid: false, errors: ['Response body is empty'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { valid: false, errors: ['Response body is not valid JSON'] };
  }

  const validateFn = ajv.compile(schema);
  const valid = validateFn(parsed) as boolean;
  const errors = valid
    ? []
    : (validateFn.errors ?? []).map(
        (e) => `${e.instancePath || '/'}: ${e.message ?? 'unknown error'}`,
      );

  return { valid, errors };
}

// ---------------------------------------------------------------------------
// Capture loading
// ---------------------------------------------------------------------------

export interface CaptureData {
  directory: string;
  manifest?: CaptureManifest;
  traffic: CapturedTraffic[];
  console: CapturedConsoleEntry[];
  timestamp: string;
  targetUrl: string;
  totalRequests: number;
}

/** Load capture data from a directory containing traffic.json (and optionally console.json). */
export function loadCaptureData(captureDir: string): CaptureData {
  const resolved = path.resolve(captureDir);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Capture directory not found: ${resolved}`);
  }

  // Try to load manifest.json first
  let manifest: CaptureManifest | undefined;
  const manifestPath = path.join(resolved, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CaptureManifest;
  }

  // Load traffic.json
  const trafficPath = path.join(resolved, 'traffic.json');
  let traffic: CapturedTraffic[] = [];
  if (fs.existsSync(trafficPath)) {
    traffic = JSON.parse(fs.readFileSync(trafficPath, 'utf-8')) as CapturedTraffic[];
  }

  // Load console.json
  const consolePath = path.join(resolved, 'console.json');
  let consoleEntries: CapturedConsoleEntry[] = [];
  if (fs.existsSync(consolePath)) {
    consoleEntries = JSON.parse(
      fs.readFileSync(consolePath, 'utf-8'),
    ) as CapturedConsoleEntry[];
  }

  // Determine session metadata
  const timestamp = manifest?.session.timestamp ?? new Date().toISOString();
  const targetUrl = manifest?.session.targetUrl ?? '';
  const totalRequests = manifest?.session.totalRequests ?? traffic.length;

  return {
    directory: resolved,
    manifest,
    traffic,
    console: consoleEntries,
    timestamp,
    targetUrl,
    totalRequests,
  };
}

// ---------------------------------------------------------------------------
// Page validation
// ---------------------------------------------------------------------------

function validatePage(page: PageSpec, capture: CaptureData): PageResult {
  // Check if the page was visited
  const navigationTraffic = capture.traffic.filter(
    (t) =>
      (t.method === 'GET' || t.method === 'get') &&
      urlMatchesPagePath(t.url, page.path),
  );
  const visited = navigationTraffic.length > 0;

  // Validate expected requests
  const requests: RequestResult[] = (page.expected_requests ?? []).map((req) =>
    validateRequest(req, capture, visited),
  );

  // Visual assertions — passive capture can't verify DOM, mark as untested
  const visualAssertions: AssertionResult[] = (page.visual_assertions ?? []).map(
    (assertion) => ({
      type: assertion.type,
      selector: 'selector' in assertion ? assertion.selector : undefined,
      description: assertion.description,
      status: 'untested' as CheckStatus,
      reason: visited
        ? 'Visual assertions require active browser execution — not verifiable from passive capture'
        : 'Page was not visited in this capture session',
    }),
  );

  // Console expectations
  const consoleResults: ConsoleResult[] = (page.console_expectations ?? []).map(
    (expectation) => validateConsole(expectation, capture, visited),
  );

  // Scenarios — best-effort matching
  const scenarioResults: ScenarioResult[] = (page.scenarios ?? []).map((scenario) =>
    validateScenario(scenario, capture, visited),
  );

  return {
    pageId: page.id,
    path: page.path,
    visited,
    requests,
    visualAssertions,
    consoleExpectations: consoleResults,
    scenarios: scenarioResults,
  };
}

function validateRequest(
  req: ExpectedRequest,
  capture: CaptureData,
  pageVisited: boolean,
): RequestResult {
  if (!pageVisited) {
    return {
      method: req.method,
      urlPattern: req.url_pattern,
      description: req.description,
      status: 'untested',
      reason: 'Parent page was not visited in this capture session',
    };
  }

  // Find matching traffic entries
  const matches = capture.traffic.filter(
    (t) =>
      t.method.toUpperCase() === req.method.toUpperCase() &&
      matchUrlPattern(t.url, req.url_pattern),
  );

  if (matches.length === 0) {
    return {
      method: req.method,
      urlPattern: req.url_pattern,
      description: req.description,
      status: 'failed',
      reason: `No ${req.method} request matching "${req.url_pattern}" found in capture`,
    };
  }

  const match = matches[0];
  const result: RequestResult = {
    method: req.method,
    urlPattern: req.url_pattern,
    description: req.description,
    status: 'passed',
    matchedUrl: match.url,
    actualStatus: match.status,
  };

  // Check status code
  if (req.response?.status !== undefined) {
    result.expectedStatus = req.response.status;
    if (match.status !== req.response.status) {
      result.status = 'failed';
      result.reason = `Expected status ${req.response.status}, got ${match.status}`;
      return result;
    }
  } else if (req.response?.status_in !== undefined) {
    result.expectedStatus = req.response.status_in[0];
    if (!req.response.status_in.includes(match.status)) {
      result.status = 'failed';
      result.reason = `Expected status in [${req.response.status_in.join(', ')}], got ${match.status}`;
      return result;
    }
  }

  // Check response body schema
  if (req.response?.body_schema) {
    const { valid, errors } = validateBodySchema(
      match.responseBody,
      req.response.body_schema as object,
    );
    result.bodySchemaValid = valid;
    result.bodySchemaErrors = errors;
    if (!valid) {
      result.status = 'failed';
      result.reason = `Response body schema validation failed: ${errors.join('; ')}`;
      return result;
    }
  }

  return result;
}

function validateConsole(
  expectation: { level: string; count?: number; exclude_pattern?: string },
  capture: CaptureData,
  pageVisited: boolean,
): ConsoleResult {
  if (!pageVisited) {
    return {
      level: expectation.level,
      expectedCount: expectation.count,
      excludePattern: expectation.exclude_pattern,
      status: 'untested',
      reason: 'Page was not visited in this capture session',
    };
  }

  if (capture.console.length === 0) {
    return {
      level: expectation.level,
      expectedCount: expectation.count,
      excludePattern: expectation.exclude_pattern,
      status: 'untested',
      reason: 'No console.json found in capture — console logs were not captured',
    };
  }

  const levelEntries = capture.console.filter(
    (e) => e.type.toLowerCase() === expectation.level.toLowerCase(),
  );
  const actualCount = levelEntries.length;

  // Check exclude_pattern
  if (expectation.exclude_pattern) {
    const re = new RegExp(expectation.exclude_pattern, 'i');
    const matching = levelEntries.filter((e) => re.test(e.text));
    if (matching.length > 0) {
      return {
        level: expectation.level,
        expectedCount: expectation.count,
        actualCount,
        excludePattern: expectation.exclude_pattern,
        status: 'failed',
        matchingEntries: matching.map((e) => e.text),
        reason: `Found ${matching.length} console.${expectation.level} entries matching excluded pattern "${expectation.exclude_pattern}"`,
      };
    }
  }

  // Check count
  if (expectation.count !== undefined) {
    if (actualCount > expectation.count) {
      return {
        level: expectation.level,
        expectedCount: expectation.count,
        actualCount,
        excludePattern: expectation.exclude_pattern,
        status: 'failed',
        matchingEntries: levelEntries.map((e) => e.text),
        reason: `Expected at most ${expectation.count} console.${expectation.level} entries, found ${actualCount}`,
      };
    }
  }

  return {
    level: expectation.level,
    expectedCount: expectation.count,
    actualCount,
    excludePattern: expectation.exclude_pattern,
    status: 'passed',
  };
}

function validateScenario(
  scenario: { id: string; description?: string; steps: Array<{ action: string; description?: string; url_pattern?: string; method?: string }> },
  capture: CaptureData,
  pageVisited: boolean,
): ScenarioResult {
  if (!pageVisited) {
    return {
      scenarioId: scenario.id,
      description: scenario.description,
      status: 'untested',
      steps: scenario.steps.map((step) => ({
        action: step.action,
        description: step.description,
        status: 'untested' as CheckStatus,
        reason: 'Page was not visited in this capture session',
      })),
    };
  }

  const steps: StepResult[] = scenario.steps.map((step) => {
    // wait_for_request steps: check if the request appears in traffic
    if (step.action === 'wait_for_request' && step.url_pattern) {
      const method = step.method?.toUpperCase() ?? undefined;
      const found = capture.traffic.some(
        (t) =>
          (!method || t.method.toUpperCase() === method) &&
          matchUrlPattern(t.url, step.url_pattern!),
      );
      return {
        action: step.action,
        description: step.description,
        status: found ? ('passed' as CheckStatus) : ('untested' as CheckStatus),
        evidence: found ? `Request matching "${step.url_pattern}" found in capture` : undefined,
        reason: found
          ? undefined
          : `No request matching "${step.url_pattern}" found — scenario may not have been exercised`,
      };
    }

    // wait_for_navigation: check if the target URL appears in traffic
    if (step.action === 'wait_for_navigation' && step.url_pattern) {
      const found = capture.traffic.some(
        (t) =>
          (t.method === 'GET' || t.method === 'get') &&
          matchUrlPattern(t.url, step.url_pattern!),
      );
      return {
        action: step.action,
        description: step.description,
        status: found ? ('passed' as CheckStatus) : ('untested' as CheckStatus),
        evidence: found ? `Navigation to "${step.url_pattern}" found in capture` : undefined,
        reason: found
          ? undefined
          : `No navigation to "${step.url_pattern}" found in capture`,
      };
    }

    // UI interaction steps (click, fill, hover, assert_visible, etc.) — untested from passive capture
    return {
      action: step.action,
      description: step.description,
      status: 'untested' as CheckStatus,
      reason: `Action "${step.action}" requires active browser execution — not verifiable from passive capture`,
    };
  });

  // Scenario status: failed if any step failed, untested if all untested, passed if any passed
  const hasFailure = steps.some((s) => s.status === 'failed');
  const hasPassed = steps.some((s) => s.status === 'passed');
  const scenarioStatus: CheckStatus = hasFailure ? 'failed' : hasPassed ? 'passed' : 'untested';

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    status: scenarioStatus,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Flow validation
// ---------------------------------------------------------------------------

function validateFlow(flow: FlowSpec, capture: CaptureData): FlowResult {
  // Check flow steps in order — we verify navigations appear in the traffic
  // and look for approximate ordering
  const navigationTraffic = capture.traffic
    .filter((t) => t.method === 'GET' || t.method === 'get')
    .sort((a, b) => a.ts - b.ts);

  const steps: FlowStepResult[] = flow.steps.map((step) => {
    return validateFlowStep(step, navigationTraffic, capture);
  });

  // Check ordering for navigate steps
  const navigateResults = steps.filter((s) => s.type === 'navigate' && s.status === 'passed');
  if (navigateResults.length > 1) {
    // Verify the ordering in the capture matches spec ordering
    let lastIndex = -1;
    let orderViolation = false;
    for (const stepResult of navigateResults) {
      if (!stepResult.path) continue;
      const idx = navigationTraffic.findIndex((t) =>
        urlMatchesPagePath(t.url, stepResult.path!),
      );
      if (idx < lastIndex) {
        orderViolation = true;
        break;
      }
      lastIndex = idx;
    }
    if (orderViolation) {
      // Mark the overall flow as failed but keep individual step results
      steps.push({
        type: 'order_check',
        description: 'Navigation sequence order check',
        status: 'failed',
        reason: 'Page navigations in capture do not follow the expected flow sequence',
      });
    }
  }

  const hasFailure = steps.some((s) => s.status === 'failed');
  const hasPassed = steps.some((s) => s.status === 'passed');
  const flowStatus: CheckStatus = hasFailure ? 'failed' : hasPassed ? 'passed' : 'untested';

  return {
    flowId: flow.id,
    description: flow.description,
    status: flowStatus,
    steps,
  };
}

function validateFlowStep(
  step: FlowStep,
  navigationTraffic: CapturedTraffic[],
  capture: CaptureData,
): FlowStepResult {
  if ('navigate' in step) {
    const found = navigationTraffic.some((t) => urlMatchesPagePath(t.url, step.navigate));
    return {
      type: 'navigate',
      description: step.description,
      path: step.navigate,
      status: found ? 'passed' : 'untested',
      evidence: found ? `Navigation to "${step.navigate}" found in capture` : undefined,
      reason: found ? undefined : `No navigation to "${step.navigate}" found in capture`,
    };
  }

  if ('assert_page' in step) {
    return {
      type: 'assert_page',
      description: step.description,
      pageId: step.assert_page,
      status: 'untested',
      reason: 'assert_page requires active browser execution — not verifiable from passive capture',
    };
  }

  // ActionFlowStep
  if ('action' in step) {
    if (step.action === 'wait_for_request' && step.url_pattern) {
      const method = step.method?.toUpperCase();
      const found = capture.traffic.some(
        (t) =>
          (!method || t.method.toUpperCase() === method) &&
          matchUrlPattern(t.url, step.url_pattern!),
      );
      return {
        type: 'action',
        description: step.description,
        status: found ? 'passed' : 'untested',
        evidence: found ? `Request matching "${step.url_pattern}" found in capture` : undefined,
        reason: found ? undefined : `No request matching "${step.url_pattern}" found in capture`,
      };
    }

    if (step.action === 'wait_for_navigation' && step.url_pattern) {
      const found = navigationTraffic.some((t) =>
        matchUrlPattern(t.url, step.url_pattern!),
      );
      return {
        type: 'action',
        description: step.description,
        status: found ? 'passed' : 'untested',
        evidence: found ? `Navigation to "${step.url_pattern}" found in capture` : undefined,
        reason: found ? undefined : `No navigation to "${step.url_pattern}" found in capture`,
      };
    }

    return {
      type: 'action',
      description: step.description,
      status: 'untested',
      reason: `Action "${step.action}" requires active browser execution — not verifiable from passive capture`,
    };
  }

  return {
    type: 'unknown',
    status: 'untested',
    reason: 'Unknown flow step type',
  };
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

function computeSummary(pages: PageResult[], flows: FlowResult[]) {
  let total = 0;
  let passed = 0;
  let failed = 0;
  let untested = 0;

  function count(status: CheckStatus) {
    total++;
    if (status === 'passed') passed++;
    else if (status === 'failed') failed++;
    else untested++;
  }

  for (const page of pages) {
    count(page.visited ? 'passed' : 'untested');
    for (const req of page.requests) count(req.status);
    for (const va of page.visualAssertions) count(va.status);
    for (const ce of page.consoleExpectations) count(ce.status);
    for (const sc of page.scenarios) {
      count(sc.status);
      for (const step of sc.steps) count(step.status);
    }
  }

  for (const flow of flows) {
    count(flow.status);
    for (const step of flow.steps) count(step.status);
  }

  const coverage = total > 0 ? Math.round(((passed + failed) / total) * 100) : 0;

  return { total, passed, failed, untested, coverage };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Validate a spec against a capture session and return a gap report. */
export function validate(spec: Spec, capture: CaptureData): GapReport {
  const pages: PageResult[] = (spec.pages ?? []).map((page) =>
    validatePage(page, capture),
  );

  const flows: FlowResult[] = (spec.flows ?? []).map((flow) =>
    validateFlow(flow, capture),
  );

  const summary = computeSummary(pages, flows);

  return {
    spec: {
      name: spec.name,
      version: spec.version,
      description: spec.description,
    },
    capture: {
      directory: capture.directory,
      timestamp: capture.timestamp,
      targetUrl: capture.targetUrl,
      totalRequests: capture.totalRequests,
    },
    summary,
    pages,
    flows,
  };
}
