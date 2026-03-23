/**
 * src/spec/lint.ts — Structural and semantic spec linter
 *
 * Validates a spec beyond JSON Schema:
 *   - Duplicate area IDs
 *   - Duplicate behavior IDs within and across areas
 *   - Empty behavior descriptions
 */

import yaml from 'js-yaml';
import Ajv from 'ajv';
import { specSchema } from './schema.js';
import type { Spec } from './types.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(specSchema);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LintError {
  /** JSON-pointer-style path to the problem (e.g. "/areas/0/id"). */
  path: string;
  /** Severity: error = must fix, warning = should fix. */
  severity: 'error' | 'warning';
  /** Human-readable message. */
  message: string;
  /** Rule identifier for filtering/suppression. */
  rule: string;
}

export interface LintResult {
  /** True if no errors (warnings are OK). */
  valid: boolean;
  /** All errors and warnings found. */
  errors: LintError[];
}

// ---------------------------------------------------------------------------
// Raw lint (parse + schema + semantic)
// ---------------------------------------------------------------------------

/**
 * Lint a spec from raw YAML/JSON string.
 * Combines parse errors, schema validation errors, and semantic lint rules.
 */
export function lintRaw(content: string, sourceName = '<string>', _specPath?: string): LintResult {
  const errors: LintError[] = [];

  // 1. Parse
  let data: unknown;
  try {
    data = yaml.load(content);
  } catch (parseErr) {
    try {
      data = JSON.parse(content);
    } catch {
      errors.push({
        path: '/',
        severity: 'error',
        message: `Failed to parse as YAML or JSON: ${(parseErr as Error).message}`,
        rule: 'parse-error',
      });
      return { valid: false, errors };
    }
  }

  if (data === null || data === undefined || typeof data !== 'object') {
    errors.push({
      path: '/',
      severity: 'error',
      message: 'Spec must be a non-null object',
      rule: 'parse-error',
    });
    return { valid: false, errors };
  }

  // 2. Schema validation
  const schemaValid = validate(data);
  if (!schemaValid && validate.errors) {
    for (const err of validate.errors) {
      errors.push({
        path: err.instancePath || '/',
        severity: 'error',
        message: err.message ?? 'unknown schema error',
        rule: 'schema',
      });
    }
  }

  // If schema validation failed badly, skip semantic checks
  if (errors.some(e => e.rule === 'schema' && e.path === '/')) {
    return { valid: false, errors };
  }

  // 3. Semantic lint
  const spec = data as Spec;
  errors.push(...lintSpec(spec));

  const hasErrors = errors.some(e => e.severity === 'error');
  return { valid: !hasErrors, errors };
}

// ---------------------------------------------------------------------------
// Semantic lint (on a parsed Spec)
// ---------------------------------------------------------------------------

/**
 * Run semantic lint rules on a parsed and schema-validated spec.
 * Returns warnings and errors beyond what JSON Schema can catch.
 */
export function lintSpec(spec: Spec, _specPath?: string): LintError[] {
  const errors: LintError[] = [];

  // Rule: duplicate area IDs
  const areaIds = new Map<string, number>();
  for (let i = 0; i < spec.areas.length; i++) {
    const area = spec.areas[i];
    if (areaIds.has(area.id)) {
      errors.push({
        path: `/areas/${i}/id`,
        severity: 'error',
        message: `Duplicate area ID "${area.id}" (first at /areas/${areaIds.get(area.id)})`,
        rule: 'duplicate-area-id',
      });
    } else {
      areaIds.set(area.id, i);
    }

    // Rule: duplicate behavior IDs within an area
    const behaviorIds = new Map<string, number>();
    for (let j = 0; j < area.behaviors.length; j++) {
      const behavior = area.behaviors[j];
      if (behaviorIds.has(behavior.id)) {
        errors.push({
          path: `/areas/${i}/behaviors/${j}/id`,
          severity: 'error',
          message: `Duplicate behavior ID "${behavior.id}" in area "${area.id}" (first at /areas/${i}/behaviors/${behaviorIds.get(behavior.id)})`,
          rule: 'duplicate-behavior-id',
        });
      } else {
        behaviorIds.set(behavior.id, j);
      }

      // Rule: empty behavior description
      if (!behavior.description.trim()) {
        errors.push({
          path: `/areas/${i}/behaviors/${j}/description`,
          severity: 'error',
          message: `Behavior "${behavior.id}" in area "${area.id}" has an empty description`,
          rule: 'empty-behavior-description',
        });
      }
    }
  }

  // Rule: duplicate behavior IDs across all areas
  const globalBehaviorIds = new Map<string, string>();
  for (const area of spec.areas) {
    for (const behavior of area.behaviors) {
      const fqId = `${area.id}/${behavior.id}`;
      if (globalBehaviorIds.has(behavior.id)) {
        const prevArea = globalBehaviorIds.get(behavior.id)!;
        if (prevArea !== area.id) {
          errors.push({
            path: `/areas`,
            severity: 'warning',
            message: `Behavior ID "${behavior.id}" appears in both area "${prevArea}" and "${area.id}". Fully-qualified IDs (${prevArea}/${behavior.id}, ${fqId}) are distinct, but bare IDs collide.`,
            rule: 'ambiguous-behavior-id',
          });
        }
      } else {
        globalBehaviorIds.set(behavior.id, area.id);
      }
    }
  }

  return errors;
}
