import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { COMMANDS } from '../cli/commands-manifest.js';
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

test('repo spec covers every supported command and no removed command area', () => {
  const { spec, provenance } = loadSpecWithProvenance(specDir);
  assert.equal(provenance.kind, 'directory');
  assert.equal(spec.target.type, 'cli');
  const commandAreas = new Set(spec.areas.map((area) => area.id));
  for (const command of COMMANDS) {
    const area = command.name === 'mcp' ? 'mcp-server' : command.name.replaceAll(' ', '-');
    assert.ok(commandAreas.has(area), `Missing contract area for ${command.name}`);
  }
  for (const removed of [
    'capture',
    'create',
    'human-mode',
    'review',
    'daemon',
    'deploy',
    'spec-compile',
    'spec-migrate-id',
  ]) {
    assert.ok(!commandAreas.has(removed), `Removed feature still promised: ${removed}`);
  }
  const ids = new Set(
    spec.areas.flatMap((area) => area.behaviors.map((behavior) => `${area.id}/${behavior.id}`)),
  );
  for (const id of [
    'verify/results-reject-invalid-identity',
    'verify/results-incomplete-never-pass',
    'verify/scripted-suite-pass-is-not-contract-pass',
    'spec-lint/lint-ignores-legacy-sidecars',
  ]) {
    assert.ok(ids.has(id), `Missing scope-reduction contract: ${id}`);
  }
});
