import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { loadSpec } from './parser.js';
import type { Area, Spec } from './types.js';

export interface SpecSizeThresholds {
  maxBytes: number;
  maxLines: number;
  maxAreas: number;
  maxBehaviors: number;
}

export interface SpecSizeMetrics {
  bytes: number;
  lines: number;
  areas: number;
  behaviors: number;
}

export interface SpecSizeAssessment {
  metrics: SpecSizeMetrics;
  overLimit: boolean;
  reasons: string[];
}

export const DEFAULT_SPEC_SIZE_THRESHOLDS: SpecSizeThresholds = {
  maxBytes: 40 * 1024,
  maxLines: 800,
  maxAreas: 12,
  maxBehaviors: 120,
};

export function assessSpecSize(
  content: string,
  spec: Spec,
  thresholds: SpecSizeThresholds = DEFAULT_SPEC_SIZE_THRESHOLDS,
): SpecSizeAssessment {
  const metrics: SpecSizeMetrics = {
    bytes: Buffer.byteLength(content, 'utf-8'),
    lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    areas: spec.areas.length,
    behaviors: spec.areas.reduce((count, area) => count + area.behaviors.length, 0),
  };
  const reasons: string[] = [];

  if (metrics.bytes > thresholds.maxBytes) {
    reasons.push(`${formatBytes(metrics.bytes)} exceeds ${formatBytes(thresholds.maxBytes)}`);
  }
  if (metrics.lines > thresholds.maxLines) {
    reasons.push(`${metrics.lines} lines exceeds ${thresholds.maxLines}`);
  }
  if (metrics.areas > thresholds.maxAreas) {
    reasons.push(`${metrics.areas} areas exceeds ${thresholds.maxAreas}`);
  }
  if (metrics.behaviors > thresholds.maxBehaviors) {
    reasons.push(`${metrics.behaviors} behaviors exceeds ${thresholds.maxBehaviors}`);
  }

  return {
    metrics,
    overLimit: reasons.length > 0,
    reasons,
  };
}

export function defaultSplitOutputPath(specPath: string): string {
  const resolved = path.resolve(specPath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved).replace(/\.(ya?ml|json)$/i, '');
  return path.join(dir, base === 'spec' ? 'spec' : base);
}

export interface SplitSpecOptions {
  outputDir?: string;
  force?: boolean;
}

export interface SplitSpecResult {
  outputDir: string;
  manifestPath: string;
  areaPaths: string[];
}

export function splitSpecFileToDirectory(specPath: string, options: SplitSpecOptions = {}): SplitSpecResult {
  const inputPath = path.resolve(specPath);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Spec file not found: ${inputPath}`);
  }
  if (fs.statSync(inputPath).isDirectory()) {
    throw new Error(`Spec is already a directory: ${inputPath}`);
  }

  const outputDir = path.resolve(options.outputDir ?? defaultSplitOutputPath(inputPath));
  if (fs.existsSync(outputDir)) {
    const stat = fs.statSync(outputDir);
    if (!stat.isDirectory()) {
      throw new Error(`Split output path exists and is not a directory: ${outputDir}`);
    }
    const entries = fs.readdirSync(outputDir).filter((entry) => entry !== '.DS_Store');
    if (entries.length > 0 && !options.force) {
      throw new Error(`Split output directory is not empty: ${outputDir}`);
    }
  }

  const spec = loadSpec(inputPath);
  const manifestPath = path.join(outputDir, 'spec.yaml');
  const areasDir = path.join(outputDir, 'areas');
  fs.mkdirSync(areasDir, { recursive: true });

  const areaPaths: string[] = [];
  const seenFileNames = new Set<string>();
  for (const area of spec.areas) {
    const fileName = uniqueAreaFileName(area, seenFileNames);
    const areaPath = path.join(areasDir, fileName);
    fs.writeFileSync(areaPath, yaml.dump(area, yamlOptions()), 'utf-8');
    areaPaths.push(areaPath);
  }

  const manifest = {
    ...spec,
    areas: areaPaths.map((areaPath) => path.relative(outputDir, areaPath)),
  };
  fs.writeFileSync(manifestPath, yaml.dump(manifest, yamlOptions()), 'utf-8');

  return { outputDir, manifestPath, areaPaths };
}

export function splitSuggestion(specPath: string): string {
  return `Run: specify spec split --spec ${specPath} --output ${defaultSplitOutputPath(specPath)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function uniqueAreaFileName(area: Area, seen: Set<string>): string {
  const base = sanitizeFileStem(area.id || area.name || 'area');
  let candidate = `${base}.yaml`;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix}.yaml`;
    suffix++;
  }
  seen.add(candidate);
  return candidate;
}

function sanitizeFileStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem || 'area';
}

function yamlOptions(): yaml.DumpOptions {
  return {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  };
}
