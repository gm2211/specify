import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listFormulas, setFormulaStatus } from './server.js';
import { addDraft, emptyFormulasFile, hashDescription, saveFormulas, defaultFormulasPath } from '../spec/formulas.js';
import { eventually, pred } from '../monitor/formula.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-review-server-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeSpecFile(specPath: string): void {
  const yaml = [
    'version: "2"',
    'name: "Test Spec"',
    'target:',
    '  type: web',
    '  url: http://localhost:3000',
    'areas:',
    '  - id: auth',
    '    name: Auth',
    '    behaviors:',
    '      - id: login',
    '        description: "User can log in with valid credentials"',
  ].join('\n') + '\n';
  fs.writeFileSync(specPath, yaml, 'utf-8');
}

function writeFormulasFile(formulasPath: string): { id: string } {
  const formula = eventually(pred('http.response', ['/api/login', '200']));
  const { file, entry } = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in with valid credentials'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  });
  saveFormulas(formulasPath, file);
  return { id: entry.id };
}

test('listFormulas joins each entry with its behavior description, pretty formula, and witnesses', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    writeFormulasFile(defaultFormulasPath(specPath));

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas.length, 1);
    const [entry] = formulas;
    assert.equal(entry.behavior, 'auth/login');
    assert.equal(entry.behaviorDescription, 'User can log in with valid credentials');
    assert.ok(entry.prettyFormula.includes('pred:http.response'));
    assert.ok(entry.witnesses.accepting.length >= 1);
    assert.ok(entry.witnesses.rejecting.length >= 1);
    assert.equal(entry.status, 'draft');
  } finally {
    cleanup();
  }
});

test('listFormulas returns an empty list when no formulas file exists yet', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { formulas } = await listFormulas(specPath);
    assert.deepEqual(formulas, []);
  } finally {
    cleanup();
  }
});

test('setFormulaStatus("approved") flips status and it survives a reload', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { id } = writeFormulasFile(defaultFormulasPath(specPath));

    const result = setFormulaStatus(specPath, id, 'approved');
    assert.deepEqual(result, { ok: true, id, status: 'approved' });

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas[0].status, 'approved');
  } finally {
    cleanup();
  }
});

test('setFormulaStatus("rejected") is preserved across subsequent lists', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { id } = writeFormulasFile(defaultFormulasPath(specPath));

    setFormulaStatus(specPath, id, 'rejected');
    const first = await listFormulas(specPath);
    assert.equal(first.formulas[0].status, 'rejected');

    // A second, unrelated read should still see the rejection.
    const second = await listFormulas(specPath);
    assert.equal(second.formulas[0].status, 'rejected');
  } finally {
    cleanup();
  }
});

test('setFormulaStatus reports not_found for an unknown id', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    writeFormulasFile(defaultFormulasPath(specPath));

    const result = setFormulaStatus(specPath, 'fml-doesnotexist', 'approved');
    assert.deepEqual(result, { error: 'not_found' });
  } finally {
    cleanup();
  }
});
