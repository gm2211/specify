import assert from 'node:assert/strict';
import test from 'node:test';

import type { Spec } from './types.js';
import { lintPath, lintSpec } from './lint.js';
import { specToYaml } from './parser.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveFormulas,
  loadFormulas,
  addDraft,
  emptyFormulasFile,
  hashDescription,
  type FormulasFile,
} from './formulas.js';
import { pred, eventually, globally, and as andF } from '../monitor/formula.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-lint-dir-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

test('lintSpec detects duplicate area IDs', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
      { id: 'auth', name: 'Auth Dup', behaviors: [{ id: 'logout', description: 'User can log out' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'duplicate-area-id'));
});

test('lintSpec detects duplicate behavior IDs within an area', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      {
        id: 'auth',
        name: 'Auth',
        behaviors: [
          { id: 'login', description: 'User can log in' },
          { id: 'login', description: 'User can log in again' },
        ],
      },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'duplicate-behavior-id'));
});

test('lintSpec detects empty behavior descriptions', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: '   ' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'empty-behavior-description'));
});

test('lintSpec warns about ambiguous behavior IDs across areas', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'submit', description: 'Submit login form' }] },
      { id: 'settings', name: 'Settings', behaviors: [{ id: 'submit', description: 'Submit settings form' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'ambiguous-behavior-id'));
});

test('lintSpec returns no errors for a valid spec', () => {
  const spec: Spec = {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
    ],
  };

  const errors = lintSpec(spec);
  assert.equal(errors.length, 0);
});

test('lintPath validates composed directory specs', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), [
      'version: "2"',
      'name: Directory Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - areas/auth.yaml',
      '',
    ].join('\n'));
    writeFile(path.join(dir, 'areas', 'auth.yaml'), [
      'id: auth',
      'name: Auth',
      'behaviors:',
      '  - id: login',
      '    description: User can log in',
      '',
    ].join('\n'));

    assert.deepEqual(lintPath(dir), { valid: true, errors: [] });
  } finally {
    cleanup();
  }
});

test('lintPath reports composed directory duplicate sources', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), [
      'version: "2"',
      'name: Directory Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - areas/a.yaml',
      '  - areas/b.yaml',
      '',
    ].join('\n'));
    writeFile(path.join(dir, 'areas', 'a.yaml'), 'id: auth\nname: Auth\nbehaviors:\n  - id: login\n    description: Login\n');
    writeFile(path.join(dir, 'areas', 'b.yaml'), 'id: auth\nname: Duplicate\nbehaviors:\n  - id: logout\n    description: Logout\n');

    const result = lintPath(dir);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) =>
      error.rule === 'composition' &&
      error.message.includes('Duplicate area ID "auth"') &&
      error.message.includes('a.yaml') &&
      error.message.includes('b.yaml'),
    ));
  } finally {
    cleanup();
  }
});

test('lintPath warns when a single-file spec is large enough to split', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'app.spec.yaml');
    const spec: Spec = {
      version: '2',
      name: 'Large Single File',
      target: { type: 'web', url: 'http://localhost:3000' },
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
    writeFile(specPath, specToYaml(spec));

    const result = lintPath(specPath);

    assert.equal(result.valid, true);
    assert.ok(result.errors.some((error) =>
      error.rule === 'oversized-single-file-spec' &&
      error.severity === 'warning' &&
      error.message.includes('specify spec split'),
    ));
  } finally {
    cleanup();
  }
});

function makeAuthSpec(): Spec {
  return {
    version: '2',
    name: 'Auth Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      { id: 'auth', name: 'Auth', behaviors: [{ id: 'login', description: 'User can log in' }] },
    ],
  };
}

test('lintPath skips dangling-learned-state entirely when there is no .specify dir', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'dangling-learned-state'));
  } finally {
    cleanup();
  }
});

test('lintPath warns about a confidence.json row for a renamed/removed behavior', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, '.specify', 'confidence.json'), JSON.stringify({
      version: 1,
      rows: {
        login: { accepts: 3, overrides: 0, lastUpdatedAt: '2026-01-01T00:00:00Z' },
        signin: { accepts: 1, overrides: 0, lastUpdatedAt: '2026-01-01T00:00:00Z' },
      },
    }));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'dangling-learned-state');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warning');
    assert.ok(warnings[0].message.includes('signin'));
    assert.equal(result.valid, true, 'warnings alone do not invalidate the spec');
  } finally {
    cleanup();
  }
});

test('lintPath warns about a dangling observation scope', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    fs.mkdirSync(path.join(dir, '.specify'), { recursive: true });
    writeFile(path.join(dir, 'specify.observations.yaml'), [
      'version: 1',
      'observations:',
      '  - id: obs-1',
      '    description: Known quirk',
      '    area_id: auth',
      '    behavior_id: login',
      '    source: user_feedback',
      '  - id: obs-2',
      '    description: Orphaned by rename',
      '    area_id: auth',
      '    behavior_id: signin',
      '    source: user_feedback',
      '',
    ].join('\n'));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'dangling-learned-state');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('obs-2'));
  } finally {
    cleanup();
  }
});

test('lintPath warns about a dangling memory-store row', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, '.specify', 'memory', 'myspec', 'web_localhost.json'), JSON.stringify({
      version: 1,
      spec_id: 'myspec',
      target_key: 'web_localhost',
      rows: [
        { id: 'mem_1', type: 'playbook', area_id: 'auth', behavior_id: 'login', content: 'click sign in', contradicted_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'mem_2', type: 'playbook', area_id: 'auth', behavior_id: 'signin', content: 'stale playbook', contradicted_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ],
    }));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'dangling-learned-state');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('mem_2'));
  } finally {
    cleanup();
  }
});

test('lintPath reports no dangling-learned-state warnings once ids match the spec', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, '.specify', 'confidence.json'), JSON.stringify({
      version: 1,
      rows: { login: { accepts: 3, overrides: 0, lastUpdatedAt: '2026-01-01T00:00:00Z' } },
    }));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'dangling-learned-state'));
  } finally {
    cleanup();
  }
});

test('lintPath does not warn about aggregate size for directory specs', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'spec.yaml'), [
      'version: "2"',
      'name: Directory Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - areas/huge.yaml',
      '',
    ].join('\n'));
    const behaviors = Array.from({ length: 121 }, (_, i) => [
      `  - id: behavior-${i}`,
      `    description: Behavior ${i} works`,
    ].join('\n')).join('\n');
    writeFile(path.join(dir, 'areas', 'huge.yaml'), [
      'id: huge',
      'name: Huge',
      'behaviors:',
      behaviors,
      '',
    ].join('\n'));

    const result = lintPath(dir);

    assert.equal(result.valid, true);
    assert.ok(!result.errors.some((error) => error.rule === 'oversized-single-file-spec'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rule: formulas (specify.formulas.yaml)
// ---------------------------------------------------------------------------

function sampleFormulasFile(behaviorDescription: string): FormulasFile {
  const { file } = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula: eventually(pred('http.response', ['200'])),
    description_hash: hashDescription(behaviorDescription),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  });
  return file;
}

test('lintPath is unaffected when there is no specify.formulas.yaml', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule.startsWith('formula') || e.rule === 'stale-formula'));
    assert.equal(result.valid, true);
  } finally {
    cleanup();
  }
});

test('lintPath accepts a valid, up-to-date formulas file with no errors or warnings', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), sampleFormulasFile('User can log in'));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'formulas-file-invalid'));
    assert.ok(!result.errors.some((e) => e.rule === 'formula-behavior-not-found'));
    assert.ok(!result.errors.some((e) => e.rule === 'duplicate-formula-id'));
    assert.ok(!result.errors.some((e) => e.rule === 'stale-formula'));
    assert.equal(result.valid, true);
  } finally {
    cleanup();
  }
});

test('lintPath reports an error when specify.formulas.yaml is malformed YAML', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(path.join(dir, 'specify.formulas.yaml'), 'formulas: [\n  - id: fml-abc\n    behavior: [unterminated');

    const result = lintPath(specPath);
    const errors = result.errors.filter((e) => e.rule === 'formulas-file-invalid');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, 'error');
    assert.equal(result.valid, false);
  } finally {
    cleanup();
  }
});

test('lintPath reports an error when a formula has a schema-invalid AST', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(
      path.join(dir, 'specify.formulas.yaml'),
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
    );

    const result = lintPath(specPath);
    const errors = result.errors.filter((e) => e.rule === 'formulas-file-invalid');
    assert.equal(errors.length, 1);
    assert.equal(result.valid, false);
  } finally {
    cleanup();
  }
});

test('lintPath reports an error when a formula references a dangling behavior', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    const { file } = addDraft(emptyFormulasFile(), {
      behavior: 'auth/signin', // renamed away from "login" — no longer exists
      formula: eventually(pred('http.response', ['200'])),
      description_hash: hashDescription('User can log in'),
      predicates_used: ['http.response'],
      provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
    });
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), file);

    const result = lintPath(specPath);
    const errors = result.errors.filter((e) => e.rule === 'formula-behavior-not-found');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, 'error');
    assert.ok(errors[0].message.includes('auth/signin'));
    assert.equal(result.valid, false);
  } finally {
    cleanup();
  }
});

test('lintPath reports an error on duplicate formula ids', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    writeFile(
      path.join(dir, 'specify.formulas.yaml'),
      [
        'version: 1',
        'predicates_version: 1',
        'formulas:',
        '  - id: fml-dup001',
        '    behavior: auth/login',
        `    description_hash: ${hashDescription('User can log in')}`,
        '    formula:',
        '      op: pred',
        '      name: http.response',
        "      args: ['200']",
        '    predicates_used: [http.response]',
        '    status: draft',
        '    provenance:',
        '      compiled_by: test',
        '      compiled_at: "2026-01-01T00:00:00Z"',
        '  - id: fml-dup001',
        '    behavior: auth/login',
        `    description_hash: ${hashDescription('User can log in')}`,
        '    formula:',
        '      op: pred',
        '      name: page.url',
        "      args: ['/dashboard']",
        '    predicates_used: [page.url]',
        '    status: draft',
        '    provenance:',
        '      compiled_by: test',
        '      compiled_at: "2026-01-01T00:00:00Z"',
        '',
      ].join('\n'),
    );

    const result = lintPath(specPath);
    const errors = result.errors.filter((e) => e.rule === 'duplicate-formula-id');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, 'error');
    assert.equal(result.valid, false);
  } finally {
    cleanup();
  }
});

test('lintPath warns when description_hash is stale relative to the current behavior text', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    // Compiled against an older description than the spec now has.
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), sampleFormulasFile('User can log in (old wording)'));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'stale-formula');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warning');
    assert.equal(result.valid, true, 'a stale-formula warning alone does not invalidate the spec');
  } finally {
    cleanup();
  }
});

test('lintPath skips the unknown-predicate rule when no predicate registry is supplied', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), sampleFormulasFile('User can log in'));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'unknown-predicate'));
  } finally {
    cleanup();
  }
});

test('lintPath warns about unknown predicates when a registry is supplied', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), sampleFormulasFile('User can log in'));

    const result = lintPath(specPath, { predicateRegistry: new Set(['page.url']) });
    const warnings = result.errors.filter((e) => e.rule === 'unknown-predicate');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].message.includes('http.response'));
  } finally {
    cleanup();
  }
});

test('lintPath reports no unknown-predicate warnings once the registry covers all used predicates', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), sampleFormulasFile('User can log in'));

    const result = lintPath(specPath, { predicateRegistry: new Set(['http.response']) });
    assert.ok(!result.errors.some((e) => e.rule === 'unknown-predicate'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Rule: entailment-refuted (parent_of decompositions)
// ---------------------------------------------------------------------------

function decompositionFormulasFile(opts: { soundLeaves: boolean }): FormulasFile {
  const behavior = 'auth/login';
  const descriptionHash = hashDescription('User can log in');
  const provenance = { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' };

  const parentFormula = globally(andF(pred('p'), pred('q')));
  const leafP = globally(pred('p'));
  const leafQ = globally(pred('q'));

  let file = emptyFormulasFile();
  const addedParent = addDraft(file, {
    behavior,
    formula: parentFormula,
    description_hash: descriptionHash,
    predicates_used: ['p', 'q'],
    provenance,
  });
  file = addedParent.file;
  const parentId = addedParent.entry.id;

  const leaves = opts.soundLeaves ? [leafP, leafQ] : [leafP];
  const leafIds: string[] = [];
  for (const leaf of leaves) {
    const added = addDraft(file, {
      behavior,
      formula: leaf,
      description_hash: descriptionHash,
      predicates_used: ['p'],
      provenance,
    });
    file = added.file;
    leafIds.push(added.entry.id);
  }

  return {
    ...file,
    formulas: file.formulas.map((f) => (f.id === parentId ? { ...f, parent_of: leafIds } : f)),
  };
}

test('lintPath warns with a plain-English counterexample when a parent_of decomposition is refuted', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    // Parent claims G(p & q); the only declared sub-check is G(p) — a hole.
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), decompositionFormulasFile({ soundLeaves: false }));

    const result = lintPath(specPath);
    const warnings = result.errors.filter((e) => e.rule === 'entailment-refuted');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, 'warning');
    assert.ok(
      warnings[0].message.includes('a scenario where every sub-check passes but the parent claim fails'),
      warnings[0].message,
    );
    assert.equal(result.valid, true, 'advisory rule: a refuted decomposition is a warning, never an error');
  } finally {
    cleanup();
  }
});

test('lintPath emits nothing for a sound parent_of decomposition', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    // Parent G(p & q) decomposed into [G(p), G(q)] — no bounded counterexample.
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), decompositionFormulasFile({ soundLeaves: true }));

    const result = lintPath(specPath);
    assert.ok(!result.errors.some((e) => e.rule === 'entailment-refuted'));
    assert.equal(result.valid, true);
  } finally {
    cleanup();
  }
});

test('lintPath reports an error when parent_of references an unknown formula id', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, specToYaml(makeAuthSpec()));
    const base = decompositionFormulasFile({ soundLeaves: false });
    const broken = {
      ...base,
      formulas: base.formulas.map((f) =>
        f.parent_of ? { ...f, parent_of: ['fml-missing'] } : f,
      ),
    };
    saveFormulas(path.join(dir, 'specify.formulas.yaml'), broken);

    const result = lintPath(specPath);
    const errors = result.errors.filter((e) => e.rule === 'entailment-parent-of-unknown-id');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, 'error');
    assert.ok(errors[0].message.includes('fml-missing'));
    assert.equal(result.valid, false);
    // A broken reference must not also produce a semantic verdict.
    assert.ok(!result.errors.some((e) => e.rule === 'entailment-refuted'));
  } finally {
    cleanup();
  }
});

test('parent_of round-trips through saveFormulas/loadFormulas and stays optional', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const formulasPath = path.join(dir, 'specify.formulas.yaml');
    const file = decompositionFormulasFile({ soundLeaves: false });
    saveFormulas(formulasPath, file);

    const loaded = loadFormulas(formulasPath);
    assert.ok(loaded);
    const parent = loaded!.formulas.find((f) => f.parent_of !== undefined);
    assert.ok(parent, 'parent entry with parent_of survives the round-trip');
    assert.equal(parent!.parent_of!.length, 1);
    const leaf = loaded!.formulas.find((f) => f.id === parent!.parent_of![0]);
    assert.ok(leaf, 'leaf id resolves after round-trip');
    assert.equal(leaf!.parent_of, undefined, 'entries without parent_of stay without it');
  } finally {
    cleanup();
  }
});
