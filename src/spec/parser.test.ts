import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSpec, loadSpecWithProvenance, SpecCompositionError, specToYaml, writeSpec } from './parser.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-spec-dir-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function manifest(name = 'Directory Spec'): string {
  return [
    'version: "2"',
    `name: ${JSON.stringify(name)}`,
    'target:',
    '  type: web',
    '  url: http://localhost:3000',
  ].join('\n') + '\n';
}

function areaYaml(id: string, behaviorId: string): string {
  return [
    `id: ${id}`,
    `name: ${id}`,
    'behaviors:',
    `  - id: ${behaviorId}`,
    `    description: ${id} ${behaviorId} works`,
  ].join('\n') + '\n';
}

test('loadSpec composes a directory manifest with explicit area order', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), manifest() + 'areas:\n  - areas/b.yaml\n  - areas/a.yaml\n');
    writeFile(path.join(dir, 'areas', 'a.yaml'), areaYaml('alpha', 'loads'));
    writeFile(path.join(dir, 'areas', 'b.yaml'), areaYaml('beta', 'loads'));

    const { spec, provenance } = loadSpecWithProvenance(dir);

    assert.deepEqual(spec.areas.map((area) => area.id), ['beta', 'alpha']);
    assert.equal(provenance.kind, 'directory');
    assert.equal(provenance.rootPath, dir);
    assert.equal(provenance.areaSources.beta, path.join(dir, 'areas', 'b.yaml'));
    assert.equal(provenance.behaviorSources['alpha/loads'], path.join(dir, 'areas', 'a.yaml'));
  } finally {
    cleanup();
  }
});

test('loadSpec composes areas directory in stable sorted order when manifest omits areas', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), manifest());
    writeFile(path.join(dir, 'areas', 'z-last.yaml'), areaYaml('last', 'loads'));
    writeFile(path.join(dir, 'areas', 'a-first.yaml'), areaYaml('first', 'loads'));

    const first = specToYaml(loadSpec(dir));
    const second = specToYaml(loadSpec(dir));

    assert.deepEqual(loadSpec(dir).areas.map((area) => area.id), ['first', 'last']);
    assert.equal(first, second);
  } finally {
    cleanup();
  }
});

test('loadSpec reports duplicate fragment IDs with both source paths', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), manifest() + 'areas:\n  - areas/one.yaml\n  - areas/two.yaml\n');
    writeFile(path.join(dir, 'areas', 'one.yaml'), areaYaml('auth', 'login'));
    writeFile(path.join(dir, 'areas', 'two.yaml'), areaYaml('auth', 'logout'));

    assert.throws(
      () => loadSpec(dir),
      (error) => {
        assert.ok(error instanceof SpecCompositionError);
        assert.match(error.message, /Duplicate area ID "auth"/);
        assert.match(error.message, /one\.yaml/);
        assert.match(error.message, /two\.yaml/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('loadSpec rejects a manifest with non-array areas', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), manifest() + 'areas: areas/auth.yaml\n');
    writeFile(path.join(dir, 'areas', 'auth.yaml'), areaYaml('auth', 'login'));

    assert.throws(
      () => loadSpec(dir),
      (error) => {
        assert.ok(error instanceof SpecCompositionError);
        assert.match(error.message, /Manifest areas must be an array/);
        assert.match(error.message, /spec\.yaml/);
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('writeSpec rejects directory specs instead of flattening fragments', () => {
  const { dir, cleanup } = tmpDir();
  try {
    assert.throws(
      () => writeSpec({
        version: '2',
        name: 'No flatten',
        target: { type: 'web', url: 'http://localhost:3000' },
        areas: [{ id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'Can log in' }] }],
      }, dir),
      /Cannot write a flattened spec document to directory spec/,
    );
  } finally {
    cleanup();
  }
});
