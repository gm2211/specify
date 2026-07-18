import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadFormulas,
  saveFormulas,
  findFormulas,
  addDraft,
  setStatus,
  emptyFormulasFile,
  hashDescription,
  formulaId,
  collectPredicateNames,
  FormulasLoadError,
  type FormulasFile,
} from './formulas.js';
import { pred, and, eventually } from '../monitor/formula.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-formulas-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function sampleFile(): FormulasFile {
  const formula = eventually(pred('http.response', ['200']));
  const entry = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  });
  return entry.file;
}

// --- Round-trip -------------------------------------------------------------

test('saveFormulas + loadFormulas round-trips preserving field order', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const filePath = path.join(dir, 'specify.formulas.yaml');
    const file = sampleFile();
    saveFormulas(filePath, file);

    const raw = fs.readFileSync(filePath, 'utf-8');
    // Field order in the dumped YAML should match schema order.
    const idIdx = raw.indexOf('id:');
    const behaviorIdx = raw.indexOf('behavior:');
    const descHashIdx = raw.indexOf('description_hash:');
    const formulaIdx = raw.indexOf('formula:');
    const predsIdx = raw.indexOf('predicates_used:');
    const statusIdx = raw.indexOf('status:');
    const provenanceIdx = raw.indexOf('provenance:');
    assert.ok(idIdx < behaviorIdx);
    assert.ok(behaviorIdx < descHashIdx);
    assert.ok(descHashIdx < formulaIdx);
    assert.ok(formulaIdx < predsIdx);
    assert.ok(predsIdx < statusIdx);
    assert.ok(statusIdx < provenanceIdx);

    const loaded = loadFormulas(filePath);
    assert.deepEqual(loaded, file);
  } finally {
    cleanup();
  }
});

test('loadFormulas returns null when the file does not exist', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const loaded = loadFormulas(path.join(dir, 'specify.formulas.yaml'));
    assert.equal(loaded, null);
  } finally {
    cleanup();
  }
});

// --- Strict load: throws on malformed content -------------------------------

test('loadFormulas throws FormulasLoadError on malformed YAML', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const filePath = path.join(dir, 'specify.formulas.yaml');
    fs.writeFileSync(filePath, 'formulas: [\n  - id: fml-abc123\n    behavior: [unterminated', 'utf-8');
    assert.throws(() => loadFormulas(filePath), FormulasLoadError);
  } finally {
    cleanup();
  }
});

test('loadFormulas throws FormulasLoadError on a schema-invalid formula AST', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const filePath = path.join(dir, 'specify.formulas.yaml');
    fs.writeFileSync(
      filePath,
      [
        'version: 1',
        'predicates_version: 1',
        'formulas:',
        '  - id: fml-abc123',
        '    behavior: auth/login',
        '    description_hash: sha256:abc',
        '    formula:',
        '      op: not_a_real_op',
        '    predicates_used: []',
        '    status: draft',
        '    provenance:',
        '      compiled_by: test',
        '      compiled_at: "2026-01-01T00:00:00Z"',
        '',
      ].join('\n'),
      'utf-8',
    );
    assert.throws(() => loadFormulas(filePath), FormulasLoadError);
  } finally {
    cleanup();
  }
});

test('loadFormulas throws FormulasLoadError when a required field is missing', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const filePath = path.join(dir, 'specify.formulas.yaml');
    fs.writeFileSync(
      filePath,
      [
        'version: 1',
        'predicates_version: 1',
        'formulas:',
        '  - id: fml-abc123',
        '    behavior: auth/login',
        '    formula:',
        '      op: pred',
        '      name: http.response',
        '    predicates_used: []',
        '    status: draft',
        '    provenance:',
        '      compiled_by: test',
        '      compiled_at: "2026-01-01T00:00:00Z"',
        '',
      ].join('\n'),
      'utf-8',
    );
    assert.throws(() => loadFormulas(filePath), FormulasLoadError);
  } finally {
    cleanup();
  }
});

// --- Helpers ------------------------------------------------------------

test('findFormulas returns only entries for the requested behavior', () => {
  const file = sampleFile();
  const found = findFormulas(file, 'auth/login');
  assert.equal(found.length, 1);
  assert.equal(found[0].behavior, 'auth/login');
  assert.equal(findFormulas(file, 'auth/logout').length, 0);
});

test('addDraft dedupes identical formula ASTs for the same behavior', () => {
  const file = sampleFile();
  const formula = eventually(pred('http.response', ['200']));
  const result = addDraft(file, {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  });
  assert.equal(result.deduped, true);
  assert.equal(result.file.formulas.length, 1);
});

test('addDraft appends a distinct formula for the same behavior (conjunction case)', () => {
  const file = sampleFile();
  const second = and(pred('page.url', ['/dashboard']));
  const result = addDraft(file, {
    behavior: 'auth/login',
    formula: second,
    description_hash: hashDescription('User can log in'),
    predicates_used: ['page.url'],
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  });
  assert.equal(result.deduped, false);
  assert.equal(result.file.formulas.length, 2);
  assert.equal(findFormulas(result.file, 'auth/login').length, 2);
});

test('setStatus updates status by id', () => {
  const file = sampleFile();
  const id = file.formulas[0].id;
  const updated = setStatus(file, id, 'approved');
  assert.equal(updated.formulas[0].status, 'approved');
  // Original is untouched.
  assert.equal(file.formulas[0].status, 'draft');
});

test('setStatus throws for an unknown id', () => {
  const file = sampleFile();
  assert.throws(() => setStatus(file, 'fml-missing', 'approved'));
});

test('formulaId is stable for the same behavior + formula content', () => {
  const formula = eventually(pred('http.response', ['200']));
  const a = formulaId('auth/login', formula);
  const b = formulaId('auth/login', eventually(pred('http.response', ['200'])));
  assert.equal(a, b);
  assert.match(a, /^fml-[0-9a-f]{6}$/);
});

test('collectPredicateNames walks the full AST', () => {
  const formula = and(
    pred('http.response', ['200']),
    eventually(pred('page.url', ['/dashboard'])),
  );
  const names = collectPredicateNames(formula);
  assert.deepEqual(new Set(names), new Set(['http.response', 'page.url']));
});
