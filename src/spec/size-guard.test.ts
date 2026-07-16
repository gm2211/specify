import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSpec, specToYaml } from './parser.js';
import {
  assessSpecSize,
  defaultSplitOutputPath,
  splitSpecFileToDirectory,
} from './size-guard.js';
import type { Spec } from './types.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-size-guard-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function sampleSpec(): Spec {
  return {
    version: '2',
    name: 'Large App',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
      { id: 'billing', name: 'Billing', behaviors: [{ id: 'pay', description: 'User can pay an invoice' }] },
    ],
  };
}

test('assessSpecSize flags specs above behavior threshold', () => {
  const spec: Spec = {
    ...sampleSpec(),
    areas: [
      {
        id: 'huge',
        name: 'Huge',
        behaviors: Array.from({ length: 121 }, (_, i) => ({
          id: `behavior-${i}`,
          description: `Behavior ${i} works`,
        })),
      },
    ],
  };
  const assessment = assessSpecSize(specToYaml(spec), spec);

  assert.equal(assessment.overLimit, true);
  assert.ok(assessment.reasons.some((reason) => reason.includes('121 behaviors')));
});

test('splitSpecFileToDirectory writes a composable manifest and area files', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'app.spec.yaml');
    const outputDir = path.join(dir, 'app.spec');
    fs.writeFileSync(specPath, specToYaml(sampleSpec()), 'utf-8');

    const result = splitSpecFileToDirectory(specPath, { outputDir });

    assert.equal(result.outputDir, outputDir);
    assert.equal(result.manifestPath, path.join(outputDir, 'spec.yaml'));
    assert.deepEqual(result.areaPaths.map((areaPath) => path.basename(areaPath)), ['auth.yaml', 'billing.yaml']);
    assert.deepEqual(loadSpec(outputDir), sampleSpec());
  } finally {
    cleanup();
  }
});

test('splitSpecFileToDirectory refuses a non-empty output directory by default', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    const outputDir = path.join(dir, 'spec');
    fs.writeFileSync(specPath, specToYaml(sampleSpec()), 'utf-8');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, 'keep.txt'), 'do not overwrite');

    assert.throws(
      () => splitSpecFileToDirectory(specPath, { outputDir }),
      /not empty/,
    );
  } finally {
    cleanup();
  }
});

test('defaultSplitOutputPath uses the extensionless spec path', () => {
  assert.equal(
    defaultSplitOutputPath('/tmp/argos.spec.yaml'),
    '/tmp/argos.spec',
  );
});
