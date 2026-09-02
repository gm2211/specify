import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { lintPath } from './lint.js';
import { loadSpecWithProvenance } from './parser.js';

function resolveSpecDir(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  // Tests run compiled from dist/src/spec/*.test.js: repo root is three levels up.
  const compiled = path.resolve(dirname, '..', '..', '..', 'specify.spec');
  if (fs.existsSync(path.join(compiled, 'spec.yaml'))) {
    return compiled;
  }
  // Fall back for running this file directly under tsx from src/spec/.
  return path.resolve(dirname, '..', '..', 'specify.spec');
}

const specDir = resolveSpecDir();

test('the repo spec directory resolves to an existing manifest', () => {
  assert.ok(
    fs.existsSync(path.join(specDir, 'spec.yaml')),
    `expected a spec.yaml manifest under ${specDir}`,
  );
});

test('repo spec (specify.spec/) lints clean', () => {
  const result = lintPath(specDir);
  const errors = result.errors.filter((e) => e.severity === 'error');
  assert.equal(
    result.valid && errors.length === 0,
    true,
    `expected no lint errors, got: ${JSON.stringify(result.errors, null, 2)}`,
  );
});

test('repo spec manifest references every area file and nothing else', () => {
  const manifestRaw = fs.readFileSync(path.join(specDir, 'spec.yaml'), 'utf-8');
  const manifest = yaml.load(manifestRaw) as { areas?: string[] };
  const referenced = [...(manifest.areas ?? [])].sort();

  for (const relativePath of referenced) {
    const fullPath = path.join(specDir, relativePath);
    assert.ok(fs.existsSync(fullPath), `manifest references missing file: ${relativePath}`);
  }

  const areasDir = path.join(specDir, 'areas');
  const entries = fs.readdirSync(areasDir, { recursive: true }) as string[];
  const actual = entries
    .filter((entry) => /\.(ya?ml|json)$/.test(entry))
    .map((entry) => path.posix.join('areas', entry.split(path.sep).join('/')))
    .sort();

  assert.deepEqual(referenced, actual);
});

test('repo spec composes to a non-trivial contract', () => {
  const { spec, provenance } = loadSpecWithProvenance(specDir);

  assert.equal(provenance.kind, 'directory');
  assert.equal(spec.target.type, 'cli');
  assert.ok(spec.areas.length >= 10, `expected >= 10 areas, got ${spec.areas.length}`);

  const totalBehaviors = spec.areas.reduce((sum, area) => sum + area.behaviors.length, 0);
  assert.ok(totalBehaviors >= 50, `expected >= 50 behaviors total, got ${totalBehaviors}`);
});
