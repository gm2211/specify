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
import type { Spec, PageSpec, ExpectedRequest, FlowSpec, FlowStep, DefaultProperties } from '../spec/types.js';
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
  DefaultResult,
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
      quantifier: req.quantifier,
      confidence: req.confidence,
    };
  }

  // Find matching traffic entries
  const matches = capture.traffic.filter(
    (t) =>
      t.method.toUpperCase() === req.method.toUpperCase() &&
      matchUrlPattern(t.url, req.url_pattern),
  );

  if (matches.length === 0) {
    // For "sometimes" quantifier in single-run, mark as untested rather than failed
    const effectiveStatus: CheckStatus = req.quantifier === 'sometimes' ? 'untested' : 'failed';
    return {
      method: req.method,
      urlPattern: req.url_pattern,
      description: req.description,
      status: effectiveStatus,
      reason: req.quantifier === 'sometimes'
        ? `No ${req.method} request matching "${req.url_pattern}" found — "sometimes" assertion requires multiple runs to confirm failure`
        : `No ${req.method} request matching "${req.url_pattern}" found in capture`,
      quantifier: req.quantifier,
      confidence: req.confidence,
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
    quantifier: req.quantifier,
    confidence: req.confidence,
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

  // ActionFlowStep (ScenarioStep discriminated union)
  if ('action' in step) {
    if (step.action === 'wait_for_request') {
      const method = step.method?.toUpperCase();
      const found = capture.traffic.some(
        (t) =>
          (!method || t.method.toUpperCase() === method) &&
          matchUrlPattern(t.url, step.url_pattern),
      );
      return {
        type: 'action',
        description: step.description,
        status: found ? 'passed' : 'untested',
        evidence: found ? `Request matching "${step.url_pattern}" found in capture` : undefined,
        reason: found ? undefined : `No request matching "${step.url_pattern}" found in capture`,
      };
    }

    if (step.action === 'wait_for_navigation') {
      const found = navigationTraffic.some((t) =>
        matchUrlPattern(t.url, step.url_pattern),
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
// Default property validation
// ---------------------------------------------------------------------------

/**
 * Validate universal default properties against captured data.
 * Defaults are considered ON unless explicitly set to false in the spec.
 */
function validateDefaults(
  defaults: DefaultProperties | undefined,
  capture: CaptureData,
): DefaultResult[] {
  // Resolve effective defaults (ON unless explicitly disabled)
  const effective = {
    no_5xx: defaults?.no_5xx ?? true,
    no_console_errors: defaults?.no_console_errors ?? true,
    no_uncaught_exceptions: defaults?.no_uncaught_exceptions ?? true,
    page_load_timeout_ms: defaults?.page_load_timeout_ms,
  };

  const results: DefaultResult[] = [];

  // Check no_5xx: scan all traffic for 5xx status codes
  if (effective.no_5xx) {
    const fiveXxEntries = capture.traffic.filter(
      (t) => t.status >= 500 && t.status < 600,
    );
    if (fiveXxEntries.length > 0) {
      const urls = fiveXxEntries.slice(0, 5).map((t) => `${t.method} ${t.url} (${t.status})`);
      results.push({
        property: 'no_5xx',
        status: 'failed',
        details: `Found ${fiveXxEntries.length} request(s) with 5xx status`,
        reason: `5xx responses: ${urls.join('; ')}${fiveXxEntries.length > 5 ? ` (and ${fiveXxEntries.length - 5} more)` : ''}`,
      });
    } else {
      results.push({
        property: 'no_5xx',
        status: 'passed',
        details: 'No 5xx status codes found in captured traffic',
      });
    }
  }

  // Check no_console_errors: look for console.error entries
  if (effective.no_console_errors) {
    if (capture.console.length === 0) {
      results.push({
        property: 'no_console_errors',
        status: 'untested',
        reason: 'No console.json found in capture — console logs were not captured',
      });
    } else {
      const errorEntries = capture.console.filter(
        (e) => e.type.toLowerCase() === 'error',
      );
      if (errorEntries.length > 0) {
        const samples = errorEntries.slice(0, 5).map((e) => e.text);
        results.push({
          property: 'no_console_errors',
          status: 'failed',
          details: `Found ${errorEntries.length} console.error entries`,
          reason: `Errors: ${samples.join('; ')}${errorEntries.length > 5 ? ` (and ${errorEntries.length - 5} more)` : ''}`,
        });
      } else {
        results.push({
          property: 'no_console_errors',
          status: 'passed',
          details: 'No console.error entries found',
        });
      }
    }
  }

  // Check no_uncaught_exceptions: look for console entries with "uncaught" or "Uncaught"
  if (effective.no_uncaught_exceptions) {
    if (capture.console.length === 0) {
      results.push({
        property: 'no_uncaught_exceptions',
        status: 'untested',
        reason: 'No console.json found in capture — console logs were not captured',
      });
    } else {
      const uncaughtPattern = /uncaught/i;
      const uncaughtEntries = capture.console.filter(
        (e) => e.type.toLowerCase() === 'error' && uncaughtPattern.test(e.text),
      );
      if (uncaughtEntries.length > 0) {
        const samples = uncaughtEntries.slice(0, 5).map((e) => e.text);
        results.push({
          property: 'no_uncaught_exceptions',
          status: 'failed',
          details: `Found ${uncaughtEntries.length} uncaught exception(s)`,
          reason: `Uncaught exceptions: ${samples.join('; ')}${uncaughtEntries.length > 5 ? ` (and ${uncaughtEntries.length - 5} more)` : ''}`,
        });
      } else {
        results.push({
          property: 'no_uncaught_exceptions',
          status: 'passed',
          details: 'No uncaught exceptions found in console',
        });
      }
    }
  }

  // Check page_load_timeout_ms: check timing if available from traffic timestamps.
  // The CapturedTraffic type may be extended with a `duration` field in future;
  // for now we cast to access it safely.
  if (effective.page_load_timeout_ms !== undefined) {
    type TrafficWithDuration = CapturedTraffic & { duration?: number };
    const navigationRequests = (capture.traffic as TrafficWithDuration[]).filter(
      (t) => (t.method === 'GET' || t.method === 'get') && t.duration !== undefined,
    );
    if (navigationRequests.length === 0) {
      results.push({
        property: 'page_load_timeout_ms',
        status: 'untested',
        reason: 'No page load timing data available in capture',
      });
    } else {
      const slowPages = navigationRequests.filter(
        (t) => (t.duration ?? 0) > effective.page_load_timeout_ms!,
      );
      if (slowPages.length > 0) {
        const urls = slowPages.slice(0, 5).map((t) => `${t.url} (${t.duration}ms)`);
        results.push({
          property: 'page_load_timeout_ms',
          status: 'failed',
          details: `${slowPages.length} page(s) exceeded ${effective.page_load_timeout_ms}ms timeout`,
          reason: `Slow pages: ${urls.join('; ')}${slowPages.length > 5 ? ` (and ${slowPages.length - 5} more)` : ''}`,
        });
      } else {
        results.push({
          property: 'page_load_timeout_ms',
          status: 'passed',
          details: `All navigation requests completed within ${effective.page_load_timeout_ms}ms`,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Multi-run validation
// ---------------------------------------------------------------------------

/**
 * Validate a spec against multiple capture sessions and merge results.
 *
 * Quantifier semantics:
 *   - "always": the assertion must pass in ALL runs; fails if ANY run shows failure.
 *   - "sometimes": the assertion must pass in at least ONE run; passes if ANY run shows true.
 *
 * Single-run behavior: "sometimes" assertions that fail are marked "untested"
 * since a single run is insufficient to determine if the assertion ever holds.
 */
export function validateMultiRun(spec: Spec, captures: CaptureData[]): GapReport {
  if (captures.length === 0) {
    throw new Error('validateMultiRun requires at least one capture session');
  }

  // Validate each capture independently
  const reports = captures.map((capture) => validate(spec, capture));

  // Use the first report as the base and merge multi-run data
  const base = reports[0];
  const runCount = reports.length;

  // Merge page results
  for (let pi = 0; pi < base.pages.length; pi++) {
    const page = base.pages[pi];

    // Merge request results
    for (let ri = 0; ri < page.requests.length; ri++) {
      const baseReq = page.requests[ri];
      const statuses = reports.map((r) => r.pages[pi]?.requests[ri]?.status ?? 'untested');
      const passedCount = statuses.filter((s) => s === 'passed').length;

      baseReq.runsChecked = runCount;
      baseReq.runsPassed = passedCount;

      if (baseReq.quantifier === 'sometimes') {
        // Passes if ANY run shows true
        baseReq.status = passedCount > 0 ? 'passed' : (runCount === 1 ? 'untested' : 'failed');
      } else {
        // "always" (default): fails if ANY run shows failure
        const failedCount = statuses.filter((s) => s === 'failed').length;
        if (failedCount > 0) baseReq.status = 'failed';
      }
    }

    // Merge visual assertion results
    for (let vi = 0; vi < page.visualAssertions.length; vi++) {
      const baseVa = page.visualAssertions[vi];
      const statuses = reports.map((r) => r.pages[pi]?.visualAssertions[vi]?.status ?? 'untested');
      const passedCount = statuses.filter((s) => s === 'passed').length;

      baseVa.runsChecked = runCount;
      baseVa.runsPassed = passedCount;

      if (baseVa.quantifier === 'sometimes') {
        baseVa.status = passedCount > 0 ? 'passed' : (runCount === 1 ? 'untested' : 'failed');
      } else {
        const failedCount = statuses.filter((s) => s === 'failed').length;
        if (failedCount > 0) baseVa.status = 'failed';
      }
    }

    // Merge console results
    for (let ci = 0; ci < page.consoleExpectations.length; ci++) {
      const baseCe = page.consoleExpectations[ci];
      const statuses = reports.map((r) => r.pages[pi]?.consoleExpectations[ci]?.status ?? 'untested');
      const passedCount = statuses.filter((s) => s === 'passed').length;

      baseCe.runsChecked = runCount;
      baseCe.runsPassed = passedCount;

      if (baseCe.quantifier === 'sometimes') {
        baseCe.status = passedCount > 0 ? 'passed' : (runCount === 1 ? 'untested' : 'failed');
      } else {
        const failedCount = statuses.filter((s) => s === 'failed').length;
        if (failedCount > 0) baseCe.status = 'failed';
      }
    }
  }

  // Recompute summary after merging
  base.summary = computeSummary(base.pages, base.flows, base.defaults);

  return base;
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

function computeSummary(pages: PageResult[], flows: FlowResult[], defaults?: DefaultResult[]) {
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

  // Include default property results in the summary
  if (defaults) {
    for (const d of defaults) count(d.status);
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

  // Validate universal default properties
  const defaults = validateDefaults(spec.defaults, capture);

  const summary = computeSummary(pages, flows, defaults);

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
    defaults,
  };
}
