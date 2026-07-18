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
import * as fs from 'fs';
import * as path from 'path';
import { specSchema } from './schema.js';
import type { Spec } from './types.js';
import {
  loadSpecWithProvenance,
  SpecCompositionError,
  SpecValidationError,
  type SpecSourceIssue,
} from './parser.js';
import { assessSpecSize, splitSuggestion } from './size-guard.js';
import { specRootDir } from './paths.js';

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
export function lintRaw(content: string, _sourceName = '<string>', _specPath?: string): LintResult {
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
  const sourcePath = _sourceName !== '-' && _sourceName !== '<string>' ? _sourceName : undefined;
  errors.push(...lintSingleFileSize(content, spec, sourcePath));

  const hasErrors = errors.some(e => e.severity === 'error');
  return { valid: !hasErrors, errors };
}

/**
 * Lint a spec source path. The source may be one file or a composed spec
 * directory. Use lintRaw for stdin/string input.
 */
export function lintPath(specPath: string): LintResult {
  try {
    const { spec, provenance } = loadSpecWithProvenance(specPath);
    const errors = lintSpec(spec, specPath);
    if (provenance.kind === 'file') {
      const content = fs.readFileSync(specPath, 'utf-8');
      errors.push(...lintSingleFileSize(content, spec, specPath));
    }
    const hasErrors = errors.some(e => e.severity === 'error');
    return { valid: !hasErrors, errors };
  } catch (err) {
    if (err instanceof SpecCompositionError) {
      const errors = err.errors.map((issue) => sourceIssueToLintError(issue));
      return { valid: false, errors };
    }
    if (err instanceof SpecValidationError) {
      return {
        valid: false,
        errors: err.errors.map((message) => ({
          path: '/',
          severity: 'error',
          message,
          rule: 'schema',
        })),
      };
    }
    return {
      valid: false,
      errors: [
        {
          path: '/',
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
          rule: 'load-error',
        },
      ],
    };
  }
}

function sourceIssueToLintError(issue: SpecSourceIssue): LintError {
  const related = issue.relatedSourcePath ? ` (first defined in ${issue.relatedSourcePath})` : '';
  return {
    path: issue.path,
    severity: 'error',
    message: `${issue.sourcePath}: ${issue.message}${related}`,
    rule: 'composition',
  };
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

  if (_specPath) {
    errors.push(...lintDanglingLearnedState(spec, _specPath));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Rule: dangling-learned-state
// ---------------------------------------------------------------------------

/**
 * Warn when learned state (confidence.json, specify.observations.yaml,
 * .specify/memory/**) references an area/behavior id that no longer exists
 * in the spec. Renaming a behavior orphans its accumulated confidence,
 * observations, and playbooks — this rule surfaces that drift so it can be
 * fixed with `specify spec migrate-id <old-fq-id> <new-fq-id>`.
 *
 * WARNING severity only (learned state is advisory, not structural), and
 * skipped entirely when the spec has no `.specify` dir yet, so a fresh spec
 * or CI checkout without any learned state stays lint-clean and deterministic.
 */
function lintDanglingLearnedState(spec: Spec, specPath: string): LintError[] {
  const errors: LintError[] = [];
  const rootDir = specRootDir(specPath);
  const specifyDir = path.join(rootDir, '.specify');
  if (!fs.existsSync(specifyDir)) return errors;

  const areaIds = new Set<string>();
  const fqIds = new Set<string>(); // "area/behavior"
  const bareBehaviorIds = new Set<string>(); // behavior id regardless of area
  for (const area of spec.areas) {
    areaIds.add(area.id);
    for (const behavior of area.behaviors) {
      fqIds.add(`${area.id}/${behavior.id}`);
      bareBehaviorIds.add(behavior.id);
    }
  }

  const isKnownScope = (areaId?: string, behaviorId?: string): boolean => {
    if (areaId && behaviorId) return fqIds.has(`${areaId}/${behaviorId}`);
    if (areaId) return areaIds.has(areaId);
    if (behaviorId) return bareBehaviorIds.has(behaviorId);
    return true; // nothing scoped to check
  };

  const danglingWarning = (message: string): LintError => ({
    path: '/',
    severity: 'warning',
    message: `${message} It may be orphaned by a rename; see "specify spec migrate-id".`,
    rule: 'dangling-learned-state',
  });

  // 1. confidence.json — rows keyed by bare behavior id or "area/behavior".
  const confidencePath = path.join(specifyDir, 'confidence.json');
  if (fs.existsSync(confidencePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(confidencePath, 'utf-8')) as { rows?: unknown } | null;
      const rows = raw && typeof raw === 'object' ? raw.rows : undefined;
      if (rows && typeof rows === 'object') {
        for (const key of Object.keys(rows as Record<string, unknown>)) {
          const known = key.includes('/') ? fqIds.has(key) : bareBehaviorIds.has(key);
          if (!known) {
            errors.push(danglingWarning(
              `confidence.json has a row for unknown behavior "${key}" — no matching behavior in the current spec.`,
            ));
          }
        }
      }
    } catch {
      // Corrupt confidence.json isn't this rule's concern.
    }
  }

  // 2. specify.observations.yaml — area_id/behavior_id per observation.
  const observationsPath = path.join(rootDir, 'specify.observations.yaml');
  if (fs.existsSync(observationsPath)) {
    try {
      const raw = yaml.load(fs.readFileSync(observationsPath, 'utf-8')) as { observations?: unknown } | null;
      const observations = raw && Array.isArray(raw.observations) ? raw.observations : [];
      for (const o of observations) {
        if (!o || typeof o !== 'object') continue;
        const areaId = (o as Record<string, unknown>).area_id as string | undefined;
        const behaviorId = (o as Record<string, unknown>).behavior_id as string | undefined;
        if (!areaId && !behaviorId) continue;
        if (!isKnownScope(areaId, behaviorId)) {
          const id = (o as Record<string, unknown>).id ?? '?';
          errors.push(danglingWarning(
            `Observation "${id}" references unknown scope "${areaId ?? '?'}/${behaviorId ?? '?'}" — no matching area/behavior in the current spec.`,
          ));
        }
      }
    } catch {
      // Corrupt observations file isn't this rule's concern.
    }
  }

  // 3. .specify/memory/<spec_id>/<target>.json — area_id/behavior_id per row.
  const memoryRoot = path.join(specifyDir, 'memory');
  if (fs.existsSync(memoryRoot)) {
    for (const specIdDir of safeReaddir(memoryRoot)) {
      const specIdPath = path.join(memoryRoot, specIdDir);
      if (!safeIsDirectory(specIdPath)) continue;
      for (const file of safeReaddir(specIdPath)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(specIdPath, file);
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { rows?: unknown } | null;
          const rows = raw && Array.isArray(raw.rows) ? raw.rows : [];
          for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const areaId = (row as Record<string, unknown>).area_id as string | undefined;
            const behaviorId = (row as Record<string, unknown>).behavior_id as string | undefined;
            if (!areaId && !behaviorId) continue;
            if (!isKnownScope(areaId, behaviorId)) {
              const id = (row as Record<string, unknown>).id ?? '?';
              const rel = path.relative(rootDir, filePath);
              errors.push(danglingWarning(
                `Memory row "${id}" in ${rel} references unknown scope "${areaId ?? '?'}/${behaviorId ?? '?'}" — no matching area/behavior in the current spec.`,
              ));
            }
          }
        } catch {
          // Corrupt memory file isn't this rule's concern.
        }
      }
    }
  }

  return errors;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function lintSingleFileSize(content: string, spec: Spec, specPath?: string): LintError[] {
  const assessment = assessSpecSize(content, spec);
  if (!assessment.overLimit) return [];

  const suggestion = specPath
    ? ` ${splitSuggestion(specPath)}`
    : ' Split this into a directory spec with one area file per feature.';
  return [
    {
      path: '/',
      severity: 'warning',
      message: `Single-file spec is getting large (${assessment.reasons.join('; ')}). ${suggestion}`,
      rule: 'oversized-single-file-spec',
    },
  ];
}
