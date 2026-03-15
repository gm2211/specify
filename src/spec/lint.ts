/**
 * src/spec/lint.ts — Structural and semantic spec linter
 *
 * Validates a spec beyond JSON Schema:
 *   - Duplicate IDs (pages, flows, scenarios)
 *   - Invalid cross-references (flow assert_page → nonexistent page)
 *   - Empty step arrays
 *   - Unreferenced template variables
 *   - Pages with no assertions at all
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { specSchema } from './schema.js';
import type { Spec, FlowStep } from './types.js';
import { markdownToNarrative, type NarrativeSection } from './narrative.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(specSchema);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LintError {
  /** JSON-pointer-style path to the problem (e.g. "/pages/0/id"). */
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
export function lintRaw(content: string, sourceName = '<string>'): LintResult {
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
export function lintSpec(spec: Spec): LintError[] {
  const errors: LintError[] = [];

  // Rule: duplicate page IDs
  const pageIds = new Map<string, number>();
  for (let i = 0; i < (spec.pages?.length ?? 0); i++) {
    const page = spec.pages![i];
    if (pageIds.has(page.id)) {
      errors.push({
        path: `/pages/${i}/id`,
        severity: 'error',
        message: `Duplicate page ID "${page.id}" (first at /pages/${pageIds.get(page.id)})`,
        rule: 'duplicate-page-id',
      });
    } else {
      pageIds.set(page.id, i);
    }
  }

  // Rule: duplicate flow IDs
  const flowIds = new Map<string, number>();
  for (let i = 0; i < (spec.flows?.length ?? 0); i++) {
    const flow = spec.flows![i];
    if (flowIds.has(flow.id)) {
      errors.push({
        path: `/flows/${i}/id`,
        severity: 'error',
        message: `Duplicate flow ID "${flow.id}" (first at /flows/${flowIds.get(flow.id)})`,
        rule: 'duplicate-flow-id',
      });
    } else {
      flowIds.set(flow.id, i);
    }
  }

  // Rule: duplicate scenario IDs within a page
  for (let i = 0; i < (spec.pages?.length ?? 0); i++) {
    const page = spec.pages![i];
    const scenarioIds = new Map<string, number>();
    for (let j = 0; j < (page.scenarios?.length ?? 0); j++) {
      const scenario = page.scenarios![j];
      if (scenarioIds.has(scenario.id)) {
        errors.push({
          path: `/pages/${i}/scenarios/${j}/id`,
          severity: 'error',
          message: `Duplicate scenario ID "${scenario.id}" within page "${page.id}"`,
          rule: 'duplicate-scenario-id',
        });
      } else {
        scenarioIds.set(scenario.id, j);
      }
    }
  }

  // Rule: flow assert_page references nonexistent page
  for (let i = 0; i < (spec.flows?.length ?? 0); i++) {
    const flow = spec.flows![i];
    for (let j = 0; j < flow.steps.length; j++) {
      const step = flow.steps[j] as FlowStep & { assert_page?: string };
      if ('assert_page' in step && step.assert_page && !pageIds.has(step.assert_page)) {
        errors.push({
          path: `/flows/${i}/steps/${j}/assert_page`,
          severity: 'error',
          message: `Flow "${flow.id}" references unknown page "${step.assert_page}"`,
          rule: 'invalid-page-ref',
        });
      }
    }
  }

  // Rule: empty steps arrays
  for (let i = 0; i < (spec.flows?.length ?? 0); i++) {
    if (spec.flows![i].steps.length === 0) {
      errors.push({
        path: `/flows/${i}/steps`,
        severity: 'warning',
        message: `Flow "${spec.flows![i].id}" has empty steps array`,
        rule: 'empty-steps',
      });
    }
  }
  for (let i = 0; i < (spec.pages?.length ?? 0); i++) {
    for (let j = 0; j < (spec.pages![i].scenarios?.length ?? 0); j++) {
      if (spec.pages![i].scenarios![j].steps.length === 0) {
        errors.push({
          path: `/pages/${i}/scenarios/${j}/steps`,
          severity: 'warning',
          message: `Scenario "${spec.pages![i].scenarios![j].id}" on page "${spec.pages![i].id}" has empty steps array`,
          rule: 'empty-steps',
        });
      }
    }
  }

  // Rule: pages with no assertions at all
  for (let i = 0; i < (spec.pages?.length ?? 0); i++) {
    const page = spec.pages![i];
    const hasAssertions =
      (page.visual_assertions?.length ?? 0) > 0 ||
      (page.expected_requests?.length ?? 0) > 0 ||
      (page.console_expectations?.length ?? 0) > 0;
    if (!hasAssertions) {
      errors.push({
        path: `/pages/${i}`,
        severity: 'warning',
        message: `Page "${page.id}" has no assertions (visual, request, or console)`,
        rule: 'no-assertions',
      });
    }
  }

  // Rule: template variables referenced but not defined
  const definedVars = new Set(Object.keys(spec.variables ?? {}));
  const specStr = JSON.stringify(spec);
  const varRefs = specStr.matchAll(/\{\{([^}]+)\}\}/g);
  const referencedVars = new Set<string>();
  for (const match of varRefs) {
    // Get the root variable name (before any dots)
    const rootVar = match[1].split('.')[0];
    referencedVars.add(rootVar);
  }
  for (const ref of referencedVars) {
    // Skip env vars and hook-saved variables
    if (!definedVars.has(ref) && !ref.startsWith('$')) {
      errors.push({
        path: '/variables',
        severity: 'warning',
        message: `Template variable "{{${ref}}}" is used but not defined in variables (may be set by a hook save_as)`,
        rule: 'undefined-variable',
      });
    }
  }

  // Rule: duplicate CLI command IDs
  const cliCmdIds = new Map<string, number>();
  for (let i = 0; i < (spec.cli?.commands?.length ?? 0); i++) {
    const cmd = spec.cli!.commands![i];
    if (cliCmdIds.has(cmd.id)) {
      errors.push({
        path: `/cli/commands/${i}/id`,
        severity: 'error',
        message: `Duplicate CLI command ID "${cmd.id}" (first at /cli/commands/${cliCmdIds.get(cmd.id)})`,
        rule: 'duplicate-cli-command-id',
      });
    } else {
      cliCmdIds.set(cmd.id, i);
    }
  }

  // Rule: narrative sync (when narrative_path is set)
  if (spec.narrative_path) {
    errors.push(...lintNarrativeSync(spec, spec.narrative_path));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Narrative ↔ spec sync validation
// ---------------------------------------------------------------------------

/**
 * Validate that a narrative companion file stays in sync with the spec.
 * Checks that all spec refs in the narrative point to existing spec items,
 * and warns about spec items that have no narrative coverage.
 */
export function lintNarrativeSync(spec: Spec, narrativePath: string): LintError[] {
  const errors: LintError[] = [];

  // Try to load the narrative file
  let resolvedPath: string;
  try {
    resolvedPath = path.resolve(narrativePath);
    if (!fs.existsSync(resolvedPath)) {
      errors.push({
        path: '/narrative_path',
        severity: 'warning',
        message: `Narrative file not found: ${narrativePath}`,
        rule: 'narrative-missing',
      });
      return errors;
    }
  } catch {
    return errors;
  }

  let narrative;
  try {
    const md = fs.readFileSync(resolvedPath, 'utf-8');
    narrative = markdownToNarrative(md);
  } catch (err) {
    errors.push({
      path: '/narrative_path',
      severity: 'warning',
      message: `Failed to parse narrative: ${(err as Error).message}`,
      rule: 'narrative-parse-error',
    });
    return errors;
  }

  // Build a set of all valid spec item refs
  const validRefs = new Set<string>();
  validRefs.add('overview');
  validRefs.add('defaults');

  for (const page of spec.pages ?? []) {
    validRefs.add(`page:${page.id}`);
    for (const scenario of page.scenarios ?? []) {
      validRefs.add(`scenario:${page.id}/${scenario.id}`);
    }
    for (const req of page.expected_requests ?? []) {
      validRefs.add(`request:${page.id}/${req.method}:${req.url_pattern}`);
    }
  }
  for (const flow of spec.flows ?? []) {
    validRefs.add(`flow:${flow.id}`);
  }

  // Collect all refs from the narrative
  const narrativeRefs = new Set<string>();
  function collectRefs(sections: NarrativeSection[]) {
    for (const s of sections) {
      for (const ref of s.specRefs) {
        narrativeRefs.add(ref);
      }
      collectRefs(s.children);
    }
  }
  collectRefs(narrative.sections);

  // Check for invalid refs (narrative points to nonexistent spec item)
  for (const ref of narrativeRefs) {
    if (ref === 'overview' || ref === 'defaults' || ref === 'meta') continue;
    if (!validRefs.has(ref)) {
      errors.push({
        path: '/narrative_path',
        severity: 'warning',
        message: `Narrative references nonexistent spec item: "${ref}"`,
        rule: 'narrative-ref-invalid',
      });
    }
  }

  // Check for missing coverage (spec items with no narrative section)
  for (const ref of validRefs) {
    if (ref === 'overview' || ref === 'defaults') continue;
    if (!narrativeRefs.has(ref)) {
      errors.push({
        path: '/narrative_path',
        severity: 'warning',
        message: `Spec item "${ref}" has no corresponding narrative section`,
        rule: 'narrative-ref-missing',
      });
    }
  }

  return errors;
}
