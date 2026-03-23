/**
 * src/agent/hooks.ts — Hook executor for setup/teardown
 *
 * Executes setup and teardown hooks from the spec.
 * V2 hooks are shell commands: { name, run, save_as? }
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { HookStep } from '../spec/types.js';

const execAsync = promisify(exec);

export interface HookContext {
  /** Spec-level variables from spec.variables */
  specVars: Record<string, string>;
  /** Runtime variables saved via save_as */
  runtimeVars: Record<string, unknown>;
}

export interface HookResult {
  name: string;
  success: boolean;
  error?: string;
  savedAs?: string;
}

/**
 * Substitute {{var.field}} and ${ENV_VAR} placeholders in a string.
 */
export function substituteVars(template: string, ctx: HookContext): string {
  let result = template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    return process.env[key] ?? '';
  });

  result = result.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split('.');
    let current: unknown = ctx.runtimeVars;
    for (const part of parts) {
      if (current !== null && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
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

async function executeStep(step: HookStep, ctx: HookContext): Promise<HookResult> {
  const command = substituteVars(step.run, ctx);

  try {
    const { stdout } = await execAsync(command, { timeout: 30_000 });
    const output = stdout.trim();

    if (step.save_as) {
      ctx.runtimeVars[step.save_as] = output;
    }

    return {
      name: step.name,
      success: true,
      savedAs: step.save_as,
    };
  } catch (err) {
    return {
      name: step.name,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
    log?.(`  [hook] ${step.name}: ${step.run}`);
    const result = await executeStep(step, ctx);
    results.push(result);
    if (!result.success) {
      log?.(`  [hook] FAILED: ${result.error}`);
    } else if (result.savedAs) {
      log?.(`  [hook] saved output as "${result.savedAs}"`);
    }
  }

  return { results, ctx };
}
