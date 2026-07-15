/**
 * src/spec/parser.ts — Load and validate a spec from YAML or JSON
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
import type { Area, Spec } from './types.js';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(specSchema);

const DIRECTORY_MANIFEST_CANDIDATES = [
  'spec.yaml',
  'spec.yml',
  'spec.json',
  'specify.spec.yaml',
  'specify.spec.yml',
  'specify.spec.json',
  'manifest.yaml',
  'manifest.yml',
  'manifest.json',
];

const FRAGMENT_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

export interface SpecSourceIssue {
  path: string;
  message: string;
  sourcePath: string;
  relatedSourcePath?: string;
}

export interface SpecProvenance {
  kind: 'file' | 'directory';
  rootPath: string;
  manifestPath?: string;
  areaSources: Record<string, string>;
  behaviorSources: Record<string, string>;
}

export interface LoadedSpec {
  spec: Spec;
  provenance: SpecProvenance;
}

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

/** Error thrown when a directory spec cannot be composed into one contract. */
export class SpecCompositionError extends Error {
  constructor(
    public readonly rootPath: string,
    public readonly errors: SpecSourceIssue[],
  ) {
    const header = `Invalid spec directory: ${rootPath}`;
    const details = errors
      .map((e) => {
        const related = e.relatedSourcePath ? ` (first defined in ${e.relatedSourcePath})` : '';
        return `  - ${e.sourcePath} ${e.path}: ${e.message}${related}`;
      })
      .join('\n');
    super(`${header}\n${details}`);
    this.name = 'SpecCompositionError';
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
  return loadSpecWithProvenance(filePath).spec;
}

/**
 * Load a spec source and retain source provenance. The source may be one YAML,
 * JSON, or a directory with a manifest and area fragments.
 */
export function loadSpecWithProvenance(filePath: string): LoadedSpec {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Spec file not found: ${resolved}`);
  }

  if (fs.statSync(resolved).isDirectory()) {
    return loadSpecDirectory(resolved);
  }

  const data = parseDataFile(resolved);
  return {
    spec: validateSpec(data, resolved),
    provenance: {
      kind: 'file',
      rootPath: path.dirname(resolved),
      areaSources: {},
      behaviorSources: {},
    },
  };
}

function parseDataFile(resolved: string): unknown {
  const raw = fs.readFileSync(resolved, 'utf-8');
  const ext = path.extname(resolved).toLowerCase();

  if (ext === '.json') {
    return JSON.parse(raw);
  }

  if (ext === '.yaml' || ext === '.yml') {
    return yaml.load(raw);
  }

  // Try YAML first, fall back to JSON.
  try {
    return yaml.load(raw);
  } catch {
    return JSON.parse(raw);
  }
}

function loadSpecDirectory(rootPath: string): LoadedSpec {
  const manifestPath = findDirectoryManifest(rootPath);
  if (!manifestPath) {
    throw new SpecCompositionError(rootPath, [
      {
        path: '/',
        sourcePath: rootPath,
        message: `Missing directory manifest (${DIRECTORY_MANIFEST_CANDIDATES.join(', ')})`,
      },
    ]);
  }

  const manifest = parseObjectFile(manifestPath, '/');
  const errors: SpecSourceIssue[] = [];
  const hasManifestAreas = Object.prototype.hasOwnProperty.call(manifest, 'areas');
  let areaEntries: unknown[] = [];
  if (hasManifestAreas) {
    if (Array.isArray(manifest.areas)) {
      areaEntries = manifest.areas;
    } else {
      errors.push({
        path: '/areas',
        sourcePath: manifestPath,
        message: 'Manifest areas must be an array of relative fragment paths or inline area objects',
      });
    }
  } else {
    areaEntries = discoverAreaFragmentPaths(rootPath)
      .map((fragmentPath) => path.relative(path.dirname(manifestPath), fragmentPath));
  }
  const areas: Area[] = [];
  const areaSources: Record<string, string> = {};
  const behaviorSources: Record<string, string> = {};

  if (errors.length === 0 && areaEntries.length === 0) {
    errors.push({
      path: '/areas',
      sourcePath: manifestPath,
      message: hasManifestAreas
        ? 'No areas declared in manifest'
        : 'No areas declared and no area fragments found under areas/',
    });
  }

  for (let i = 0; i < areaEntries.length; i++) {
    const entry = areaEntries[i];
    const loaded = loadAreaEntry(entry, {
      manifestPath,
      manifestIndex: i,
    });
    errors.push(...loaded.errors);
    for (const item of loaded.areas) {
      const existingAreaSource = areaSources[item.area.id];
      if (existingAreaSource) {
        errors.push({
          path: `/areas/${areas.length}/id`,
          sourcePath: item.sourcePath,
          relatedSourcePath: existingAreaSource,
          message: `Duplicate area ID "${item.area.id}"`,
        });
        continue;
      }

      areaSources[item.area.id] = item.sourcePath;
      const behaviorIds = new Map<string, string>();
      for (const behavior of Array.isArray(item.area.behaviors) ? item.area.behaviors : []) {
        const behaviorKey = `${item.area.id}/${behavior.id}`;
        const existingBehaviorSource = behaviorIds.get(behavior.id);
        if (existingBehaviorSource) {
          errors.push({
            path: `/areas/${areas.length}/behaviors/${item.area.behaviors.indexOf(behavior)}/id`,
            sourcePath: item.sourcePath,
            relatedSourcePath: existingBehaviorSource,
            message: `Duplicate behavior ID "${behavior.id}" in area "${item.area.id}"`,
          });
        } else {
          behaviorIds.set(behavior.id, item.sourcePath);
          behaviorSources[behaviorKey] = item.sourcePath;
        }
      }
      areas.push(item.area);
    }
  }

  if (errors.length > 0) {
    throw new SpecCompositionError(rootPath, errors);
  }

  const composed = {
    ...manifest,
    areas,
  };

  return {
    spec: validateSpec(composed, manifestPath),
    provenance: {
      kind: 'directory',
      rootPath,
      manifestPath,
      areaSources,
      behaviorSources,
    },
  };
}

function findDirectoryManifest(rootPath: string): string | null {
  for (const candidate of DIRECTORY_MANIFEST_CANDIDATES) {
    const fullPath = path.join(rootPath, candidate);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }
  }
  return null;
}

function discoverAreaFragmentPaths(rootPath: string): string[] {
  const areasDir = path.join(rootPath, 'areas');
  if (!fs.existsSync(areasDir) || !fs.statSync(areasDir).isDirectory()) {
    return [];
  }

  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir).sort()) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile() && FRAGMENT_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
        out.push(fullPath);
      }
    }
  };
  visit(areasDir);
  return out.sort((a, b) => path.relative(rootPath, a).localeCompare(path.relative(rootPath, b)));
}

interface LoadAreaEntryContext {
  manifestPath: string;
  manifestIndex: number;
}

function loadAreaEntry(
  entry: unknown,
  ctx: LoadAreaEntryContext,
): { areas: Array<{ area: Area; sourcePath: string }>; errors: SpecSourceIssue[] } {
  if (typeof entry === 'string') {
    const sourcePath = path.resolve(path.dirname(ctx.manifestPath), entry);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      return {
        areas: [],
        errors: [
          {
            path: `/areas/${ctx.manifestIndex}`,
            sourcePath: ctx.manifestPath,
            message: `Area fragment not found: ${entry}`,
          },
        ],
      };
    }
    return areaObjectsFromFragment(sourcePath);
  }

  if (entry !== null && typeof entry === 'object') {
    return { areas: [{ area: entry as Area, sourcePath: ctx.manifestPath }], errors: [] };
  }

  return {
    areas: [],
    errors: [
      {
        path: `/areas/${ctx.manifestIndex}`,
        sourcePath: ctx.manifestPath,
        message: 'Area entry must be a relative fragment path or an inline area object',
      },
    ],
  };
}

function areaObjectsFromFragment(sourcePath: string): {
  areas: Array<{ area: Area; sourcePath: string }>;
  errors: SpecSourceIssue[];
} {
  const data = parseDataFile(sourcePath);
  if (Array.isArray(data)) {
    return { areas: data.map((area) => ({ area: area as Area, sourcePath })), errors: [] };
  }
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.areas)) {
      return { areas: obj.areas.map((area) => ({ area: area as Area, sourcePath })), errors: [] };
    }
    if (obj.area && typeof obj.area === 'object') {
      return { areas: [{ area: obj.area as Area, sourcePath }], errors: [] };
    }
    return { areas: [{ area: data as Area, sourcePath }], errors: [] };
  }
  return {
    areas: [],
    errors: [{ path: '/', sourcePath, message: 'Area fragment must contain an area object or an array of area objects' }],
  };
}

function parseObjectFile(filePath: string, pointer: string): Record<string, unknown> {
  const data = parseDataFile(filePath);
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new SpecCompositionError(path.dirname(filePath), [
      { path: pointer, sourcePath: filePath, message: 'Manifest must be a non-null object' },
    ]);
  }
  return data as Record<string, unknown>;
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
 * Validate a parsed object against the spec schema.
 */
function validateSpec(data: unknown, source: string): Spec {
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new SpecValidationError(source, ['Spec must be a non-null object']);
  }

  const valid = validate(data);

  if (!valid && validate.errors) {
    const errors = validate.errors.map((err) => {
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
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot write a flattened spec document to directory spec: ${resolved}`);
  }
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
