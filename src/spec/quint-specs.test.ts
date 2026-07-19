import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  loadQuintSpecs,
  saveQuintSpecs,
  addQuintDraft,
  setQuintSpecStatus,
  findQuintSpecs,
  approvedQuintSpecs,
  emptyQuintSpecsFile,
  quintSpecId,
  hashNarrative,
  QuintSpecsLoadError,
  QuintSpecIdCollisionError,
  type QuintSpecsFile,
  type QuintSpecProvenance,
} from './quint-specs.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quint-specs-'));
  return path.join(dir, 'specify.quint.yaml');
}

const PROV: QuintSpecProvenance = { drafted_by: 'llm', drafted_at: '2026-07-18T00:00:00Z', model: 'test-model' };

function draft(flow: string, specText: string): Parameters<typeof addQuintDraft>[1] {
  return {
    flow,
    spec_text: specText,
    description_hash: hashNarrative('narrative'),
    predicates_used: ['page.url'],
    provenance: PROV,
  };
}

// ---------------------------------------------------------------------------
// ids + hashing
// ---------------------------------------------------------------------------

test('quintSpecId: stable and content-derived', () => {
  const a = quintSpecId('auth/login', 'module auth {}');
  const b = quintSpecId('auth/login', 'module auth {}');
  const c = quintSpecId('auth/login', 'module auth { var x: int }');
  assert.equal(a, b);
  assert.notEqual(a, c);
  // 10 hex chars after the prefix (widened from 6 to keep collisions negligible).
  assert.match(a, /^qnt-[0-9a-f]{10}$/);
});

// ---------------------------------------------------------------------------
// addQuintDraft
// ---------------------------------------------------------------------------

test('addQuintDraft: appends a new draft with draft status', () => {
  const { file, entry, deduped } = addQuintDraft(emptyQuintSpecsFile(), draft('auth/login', 'module auth {}'));
  assert.equal(deduped, false);
  assert.equal(entry.status, 'draft');
  assert.equal(entry.flow, 'auth/login');
  assert.equal(file.specs.length, 1);
});

test('addQuintDraft: dedupes an identical (flow, spec_text)', () => {
  const first = addQuintDraft(emptyQuintSpecsFile(), draft('auth/login', 'module auth {}'));
  const second = addQuintDraft(first.file, draft('auth/login', 'module auth {}'));
  assert.equal(second.deduped, true);
  assert.equal(second.file.specs.length, 1);
  assert.equal(second.entry.id, first.entry.id);
});

test('addQuintDraft: same flow, different text is a new entry', () => {
  const first = addQuintDraft(emptyQuintSpecsFile(), draft('auth/login', 'module auth {}'));
  const second = addQuintDraft(first.file, draft('auth/login', 'module auth { var x: int }'));
  assert.equal(second.deduped, false);
  assert.equal(second.file.specs.length, 2);
});

test('addQuintDraft: an id collision between DIFFERENT content throws, never aliases', () => {
  // Force the collision: pre-seed an entry whose id equals what the new,
  // content-different draft will derive.
  const collidingId = quintSpecId('auth/login', 'module auth { /* v2 */ }');
  const seeded: QuintSpecsFile = {
    version: 1,
    specs: [
      {
        id: collidingId,
        flow: 'checkout/pay',
        description_hash: hashNarrative('other'),
        spec_text: 'module checkout {}',
        predicates_used: [],
        status: 'draft',
        provenance: PROV,
      },
    ],
  };
  assert.throws(
    () => addQuintDraft(seeded, draft('auth/login', 'module auth { /* v2 */ }')),
    QuintSpecIdCollisionError,
  );
});

// ---------------------------------------------------------------------------
// setStatus + queries
// ---------------------------------------------------------------------------

test('setQuintSpecStatus: flips status; approvedQuintSpecs filters', () => {
  const { file, entry } = addQuintDraft(emptyQuintSpecsFile(), draft('auth/login', 'module auth {}'));
  assert.equal(approvedQuintSpecs(file).length, 0);
  const approved = setQuintSpecStatus(file, entry.id, 'approved');
  assert.equal(approvedQuintSpecs(approved).length, 1);
  assert.equal(findQuintSpecs(approved, 'auth/login')[0].status, 'approved');
});

test('setQuintSpecStatus: unknown id throws', () => {
  assert.throws(() => setQuintSpecStatus(emptyQuintSpecsFile(), 'qnt-nope', 'approved'));
});

// ---------------------------------------------------------------------------
// load/save round-trip + strictness
// ---------------------------------------------------------------------------

test('save + load round-trips and preserves field order/status', () => {
  const p = tmpFile();
  const { file } = addQuintDraft(emptyQuintSpecsFile(), draft('auth/login', 'module auth {}'));
  const approved = setQuintSpecStatus(file, file.specs[0].id, 'approved');
  saveQuintSpecs(p, approved);
  const loaded = loadQuintSpecs(p);
  assert.ok(loaded);
  assert.equal(loaded.specs.length, 1);
  assert.equal(loaded.specs[0].status, 'approved');
  assert.equal(loaded.specs[0].spec_text, 'module auth {}');
  assert.equal(loaded.specs[0].provenance.model, 'test-model');
});

test('loadQuintSpecs: absent file is null (not an error)', () => {
  assert.equal(loadQuintSpecs(path.join(os.tmpdir(), 'does-not-exist-quint.yaml')), null);
});

test('loadQuintSpecs: STRICT — malformed content throws', () => {
  const p = tmpFile();
  fs.writeFileSync(p, 'version: 1\nspecs:\n  - id: x\n', 'utf-8'); // missing flow/spec_text/status/provenance
  assert.throws(() => loadQuintSpecs(p), QuintSpecsLoadError);
});

test('loadQuintSpecs: wrong version throws', () => {
  const p = tmpFile();
  const file: QuintSpecsFile = { version: 2 as unknown as 1, specs: [] };
  fs.writeFileSync(p, `version: ${file.version}\nspecs: []\n`, 'utf-8');
  assert.throws(() => loadQuintSpecs(p), QuintSpecsLoadError);
});

test('loadQuintSpecs: non-fully-qualified flow throws', () => {
  const p = tmpFile();
  saveQuintSpecs(p, {
    version: 1,
    specs: [
      {
        id: 'qnt-x',
        flow: 'notqualified',
        description_hash: hashNarrative('n'),
        spec_text: 'module x {}',
        predicates_used: [],
        status: 'draft',
        provenance: PROV,
      },
    ],
  });
  assert.throws(() => loadQuintSpecs(p), QuintSpecsLoadError);
});
