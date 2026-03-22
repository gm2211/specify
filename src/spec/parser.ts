/**
 * src/spec/parser.ts — Load and validate a spec from YAML or JSON
 *
 * Supports both v1 (computable) and v2 (behavioral) spec formats.
 * Version is detected from the `version` field and the correct schema is applied.
 *
 * Usage:
 *   import { loadSpec } from './parser.js';
 *   const spec = loadSpec('path/to/spec.yaml');
 *   // throws with descriptive errors if validation fails
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import { specSchema } from './schema.js';
import { specSchemaV2 } from './schema-v2.js';
import type { Spec } from './types.js';

const ajv = new Ajv({ allErrors: true });
const validateV1 = ajv.compile(specSchema);
const validateV2 = ajv.compile(specSchemaV2);

/** Error thrown when a spec file fails validation. */
export class SpecValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly errors: string[],
  ) {
    const header = `Invalid spec: ${filePath}`;
    const details = errors.map((e) => `  - ${e}`).join('\n');
    super(`${header}\n${details}`);
    this.name = 'SpecValidationError';
  }
}

/**
 * Load a spec from a YAML or JSON file.
 *
 * @param filePath - Path to the spec file (.yaml, .yml, or .json)
 * @returns Parsed and validated Spec object
 * @throws SpecValidationError if the spec fails schema validation
 * @throws Error if the file cannot be read or parsed
 */
export function loadSpec(filePath: string): Spec {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Spec file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  const ext = path.extname(resolved).toLowerCase();

  let data: unknown;
  if (ext === '.json') {
    data = JSON.parse(raw);
  } else if (ext === '.yaml' || ext === '.yml') {
    data = yaml.load(raw);
  } else {
    // Try YAML first, fall back to JSON
    try {
      data = yaml.load(raw);
    } catch {
      data = JSON.parse(raw);
    }
  }

  return validateSpec(data, resolved);
}

/**
 * Parse a spec from a YAML or JSON string.
 *
 * @param content - YAML or JSON string
 * @param sourceName - Optional name for error messages
 * @returns Parsed and validated Spec object
 */
export function parseSpec(content: string, sourceName = '<string>'): Spec {
  let data: unknown;
  try {
    data = yaml.load(content);
  } catch {
    data = JSON.parse(content);
  }

  return validateSpec(data, sourceName);
}

/**
 * Validate a parsed object against the appropriate spec schema.
 * Detects v1 vs v2 from the `version` field.
 */
function validateSpec(data: unknown, source: string): Spec {
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new SpecValidationError(source, ['Spec must be a non-null object']);
  }

  const obj = data as Record<string, unknown>;
  const isV2 = obj.version === '2';
  const validator = isV2 ? validateV2 : validateV1;

  if (isV2) {
    process.stderr.write('');  // v2 is the new format, no warning needed
  } else if (obj.version === '1.0') {
    // v1 still supported — deprecation warning will be added later
  }

  const valid = validator(data);

  if (!valid && validator.errors) {
    const errors = validator.errors.map((err) => {
      const path = err.instancePath || '/';
      const msg = err.message ?? 'unknown error';
      return `${path}: ${msg}`;
    });
    throw new SpecValidationError(source, errors);
  }

  return data as Spec;
}

/**
 * Serialize a spec to a YAML string.
 */
export function specToYaml(spec: Spec): string {
  return yaml.dump(spec, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}

/**
 * Write a spec to a file (YAML or JSON based on extension).
 */
export function writeSpec(spec: Spec, filePath: string): void {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(resolved).toLowerCase();
  let content: string;

  if (ext === '.json') {
    content = JSON.stringify(spec, null, 2) + '\n';
  } else {
    content = specToYaml(spec);
  }

  fs.writeFileSync(resolved, content, 'utf-8');
}
