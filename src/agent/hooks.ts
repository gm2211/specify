/**
 * src/agent/hooks.ts — Hook executor for setup/teardown
 *
 * Executes setup and teardown hooks from the spec:
 *   - api_call hooks: make HTTP requests, optionally saving response data
 *   - shell hooks: run shell commands, optionally saving stdout
 *   - Variable substitution: {{var.field}} and ${ENV_VAR} in URLs, bodies, commands
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { HookStep, ApiCallHookStep, ShellHookStep } from '../spec/types.js';

const execAsync = promisify(exec);

export interface HookContext {
  /** Spec-level variables from spec.variables */
  specVars: Record<string, string>;
  /** Runtime variables saved via save_as */
  runtimeVars: Record<string, unknown>;
}

export interface HookResult {
  name: string;
  type: string;
  success: boolean;
  error?: string;
  savedAs?: string;
}

/**
 * Substitute {{var.field}} and ${ENV_VAR} placeholders in a string.
 * {{var.field}} — access runtimeVars['var']['field']
 * {{field}} — access runtimeVars['field'] or specVars['field']
 * ${ENV_VAR} — access process.env['ENV_VAR']
 */
export function substituteVars(template: string, ctx: HookContext): string {
  // Replace ${ENV_VAR}
  let result = template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    return process.env[key] ?? '';
  });

  // Replace {{var.field}} — nested access
  result = result.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split('.');
    let current: unknown = ctx.runtimeVars;
    for (const part of parts) {
      if (current !== null && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        // Fall back to specVars for single-part expressions
        if (parts.length === 1) {
          return ctx.specVars[part] ?? '';
        }
        return '';
      }
    }
    return String(current ?? '');
  });

  return result;
}

/** Substitute vars in any value (strings recursively, objects/arrays recursively). */
function substituteDeep(value: unknown, ctx: HookContext): unknown {
  if (typeof value === 'string') {
    return substituteVars(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v, ctx));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteDeep(v, ctx);
    }
    return result;
  }
  return value;
}

async function executeApiCall(step: ApiCallHookStep, ctx: HookContext): Promise<HookResult> {
  const url = substituteVars(step.url, ctx);
  const method = step.method.toUpperCase();

  const headers: Record<string, string> = {};
  if (step.headers) {
    for (const [k, v] of Object.entries(step.headers)) {
      headers[k] = substituteVars(v, ctx);
    }
  }

  let bodyStr: string | undefined;
  let body = step.body;
  if (body !== undefined) {
    body = substituteDeep(body, ctx);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    bodyStr = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: bodyStr,
    });

    let responseData: unknown = null;
    const ct = response.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      try {
        responseData = await response.json();
      } catch {
        responseData = await response.text();
      }
    } else {
      responseData = await response.text();
    }

    if (step.save_as) {
      ctx.runtimeVars[step.save_as] = responseData;
    }

    if (!response.ok) {
      return {
        name: step.name,
        type: 'api_call',
        success: false,
        error: `HTTP ${response.status} ${response.statusText} from ${url}`,
        savedAs: step.save_as,
      };
    }

    return {
      name: step.name,
      type: 'api_call',
      success: true,
      savedAs: step.save_as,
    };
  } catch (err) {
    return {
      name: step.name,
      type: 'api_call',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeShell(step: ShellHookStep, ctx: HookContext): Promise<HookResult> {
  const command = substituteVars(step.command, ctx);

  try {
    const { stdout } = await execAsync(command, { timeout: 30_000 });
    const output = stdout.trim();

    if (step.save_as) {
      ctx.runtimeVars[step.save_as] = output;
    }

    return {
      name: step.name,
      type: 'shell',
      success: true,
      savedAs: step.save_as,
    };
  } catch (err) {
    return {
      name: step.name,
      type: 'shell',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeHookStep(step: HookStep, ctx: HookContext): Promise<HookResult> {
  if (step.type === 'api_call') {
    return executeApiCall(step, ctx);
  }
  if (step.type === 'shell') {
    return executeShell(step, ctx);
  }
  return {
    name: (step as HookStep).name,
    type: 'unknown',
    success: false,
    error: `Unknown hook type`,
  };
}

export interface HookRunResult {
  results: HookResult[];
  ctx: HookContext;
}

/** Execute a list of hook steps, accumulating variable context. */
export async function executeHooks(
  steps: HookStep[],
  ctx: HookContext,
  log?: (msg: string) => void,
): Promise<HookRunResult> {
  const results: HookResult[] = [];

  for (const step of steps) {
    log?.(`  [hook] ${step.type}: ${step.name}`);
    const result = await executeHookStep(step, ctx);
    results.push(result);
    if (!result.success) {
      log?.(`  [hook] FAILED: ${result.error}`);
    } else if (result.savedAs) {
      log?.(`  [hook] saved response as "${result.savedAs}"`);
    }
  }

  return { results, ctx };
}
