/**
 * src/validation/assumptions.ts — Assumption validation
 *
 * Validates spec-level assumptions (preconditions) before running the
 * main validation. If assumptions fail, the spec environment may not
 * be suitable for valid testing.
 */

import type { Assumption } from '../spec/types.js';
import type { AssumptionResult, CheckStatus } from './types.js';

/**
 * Validate all assumptions in a spec and return results.
 *
 * @param assumptions - Array of assumption definitions from the spec.
 * @param ctx - Optional context (e.g. base URL for relative URLs).
 * @returns Array of assumption results.
 */
export async function validateAssumptions(
  assumptions: Assumption[],
  ctx?: { baseUrl?: string; variables?: Record<string, string> },
): Promise<AssumptionResult[]> {
  const results: AssumptionResult[] = [];

  for (const assumption of assumptions) {
    switch (assumption.type) {
      case 'url_reachable':
        results.push(await checkUrlReachable(assumption, ctx));
        break;
      case 'env_var_set':
        results.push(checkEnvVarSet(assumption));
        break;
      case 'api_returns':
        results.push(await checkApiReturns(assumption, ctx));
        break;
      case 'selector_exists':
        results.push(await checkSelectorExists(assumption, ctx));
        break;
    }
  }

  return results;
}

/**
 * Check that a URL is reachable (responds with 2xx to a HEAD request).
 */
async function checkUrlReachable(
  assumption: { type: 'url_reachable'; url: string; description?: string },
  ctx?: { baseUrl?: string; variables?: Record<string, string> },
): Promise<AssumptionResult> {
  const url = resolveAssumptionUrl(assumption.url, ctx);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });
    return {
      type: assumption.type,
      description: assumption.description,
      status: response.ok ? 'passed' : 'failed',
      reason: response.ok ? undefined : `URL returned status ${response.status}`,
    };
  } catch (err) {
    return {
      type: assumption.type,
      description: assumption.description,
      status: 'failed',
      reason: `URL unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check that an environment variable is set and non-empty.
 */
function checkEnvVarSet(
  assumption: { type: 'env_var_set'; name: string; description?: string },
): AssumptionResult {
  const value = process.env[assumption.name];
  return {
    type: assumption.type,
    description: assumption.description,
    status: value !== undefined && value !== '' ? 'passed' : 'failed',
    reason:
      value !== undefined && value !== ''
        ? undefined
        : `Environment variable ${assumption.name} is not set`,
  };
}

/**
 * Check that an API endpoint returns the expected status code.
 */
async function checkApiReturns(
  assumption: {
    type: 'api_returns';
    url: string;
    method?: string;
    status?: number;
    description?: string;
  },
  ctx?: { baseUrl?: string; variables?: Record<string, string> },
): Promise<AssumptionResult> {
  const url = resolveAssumptionUrl(assumption.url, ctx);
  try {
    const response = await fetch(url, {
      method: assumption.method ?? 'GET',
      signal: AbortSignal.timeout(10000),
    });
    const expectedStatus = assumption.status ?? 200;
    const passed = response.status === expectedStatus;
    return {
      type: assumption.type,
      description: assumption.description,
      status: passed ? 'passed' : 'failed',
      reason: passed
        ? undefined
        : `Expected status ${expectedStatus}, got ${response.status}`,
    };
  } catch (err) {
    return {
      type: assumption.type,
      description: assumption.description,
      status: 'failed',
      reason: `API request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check that a CSS selector exists on a page.
 *
 * This requires an active browser session, so for passive validation
 * it is marked as "untested".
 */
async function checkSelectorExists(
  assumption: {
    type: 'selector_exists';
    url: string;
    selector: string;
    description?: string;
  },
  _ctx?: { baseUrl?: string; variables?: Record<string, string> },
): Promise<AssumptionResult> {
  // selector_exists requires a browser; for passive validation, mark as untested
  return {
    type: assumption.type,
    description: assumption.description,
    status: 'untested' as CheckStatus,
    reason: 'selector_exists assumptions require active browser execution',
  };
}

function resolveAssumptionUrl(
  template: string,
  ctx?: { baseUrl?: string; variables?: Record<string, string> },
): string {
  const variables: Record<string, string> = { ...(ctx?.variables ?? {}) };
  if (ctx?.baseUrl) {
    variables.base_url = ctx.baseUrl;
  }

  let resolved = template;

  // Resolve nested combinations like {{base_url}} -> ${TARGET_BASE_URL} -> https://...
  for (let i = 0; i < 3; i++) {
    const next = resolved
      .replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
        const variableValue = variables[key.trim()];
        return variableValue ?? match;
      })
      .replace(/\$\{([^}]+)\}/g, (match, key: string) => {
        return process.env[key] ?? match;
      });

    if (next === resolved) break;
    resolved = next;
  }

  return resolved;
}

/**
 * Check whether all assumptions were met (passed or untested).
 *
 * @param results - Array of assumption results.
 * @returns true if no assumption explicitly failed.
 */
export function allAssumptionsMet(results: AssumptionResult[]): boolean {
  return results.every((r) => r.status === 'passed' || r.status === 'untested');
}
