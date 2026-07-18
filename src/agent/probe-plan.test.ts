import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProbePlan, buildProbePlanWithLog } from './probe-plan.js';
import { canonicalProbeKey } from '../monitor/predicates.js';
import { and, eventually, globally, not, pred } from '../monitor/formula.js';
import {
  addDraft,
  emptyFormulasFile,
  hashDescription,
  setStatus,
  type FormulasFile,
} from '../spec/formulas.js';

const PROVENANCE = { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' };

function addFormula(
  file: FormulasFile,
  behavior: string,
  formula: Parameters<typeof addDraft>[1]['formula'],
  status: 'draft' | 'approved' | 'rejected' = 'draft',
): FormulasFile {
  const { file: withDraft, entry } = addDraft(file, {
    behavior,
    formula,
    description_hash: hashDescription(behavior),
    predicates_used: [],
    provenance: PROVENANCE,
  });
  if (status === 'draft') return withDraft;
  return setStatus(withDraft, entry.id, status);
}

// --- canonicalProbeKey -------------------------------------------------------

test('canonicalProbeKey is stable and keyed by documented arg names', () => {
  const key1 = canonicalProbeKey('dom.visible', ['#toast']);
  const key2 = canonicalProbeKey('dom.visible', ['#toast']);
  assert.equal(key1, key2);
  assert.equal(key1, 'dom.visible({"selector":"#toast"})');
});

test('canonicalProbeKey distinguishes predicate name and args', () => {
  const k1 = canonicalProbeKey('dom.exists', ['#a']);
  const k2 = canonicalProbeKey('dom.exists', ['#b']);
  const k3 = canonicalProbeKey('dom.visible', ['#a']);
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});

test('canonicalProbeKey maps dom.count positional args to selector/op/n', () => {
  const key = canonicalProbeKey('dom.count', ['.cart-item', 'gte', '1']);
  assert.equal(key, 'dom.count({"selector":".cart-item","op":"gte","n":"1"})');
});

// --- buildProbePlan: extraction ----------------------------------------------

test('buildProbePlan extracts dom.* predicate nodes from an approved formula', () => {
  let file = emptyFormulasFile();
  file = addFormula(file, 'checkout/confirm', globally(pred('dom.visible', ['#toast'])), 'approved');

  const plan = buildProbePlan(file);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].predicate, 'dom.visible');
  assert.deepEqual(plan[0].args, ['#toast']);
  assert.equal(plan[0].key, canonicalProbeKey('dom.visible', ['#toast']));
});

test('buildProbePlan includes draft formulas (shadow mode needs data too)', () => {
  let file = emptyFormulasFile();
  file = addFormula(file, 'checkout/confirm', pred('dom.exists', ['#banner']), 'draft');

  const plan = buildProbePlan(file);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].predicate, 'dom.exists');
});

test('buildProbePlan excludes rejected formulas', () => {
  let file = emptyFormulasFile();
  file = addFormula(file, 'checkout/confirm', pred('dom.exists', ['#banner']), 'rejected');

  const plan = buildProbePlan(file);

  assert.equal(plan.length, 0);
});

test('buildProbePlan ignores non-dom.* predicates', () => {
  let file = emptyFormulasFile();
  file = addFormula(
    file,
    'checkout/confirm',
    and(pred('http.response', ['/api/checkout', '200']), pred('page.url', ['/confirm'])),
    'approved',
  );

  const plan = buildProbePlan(file);

  assert.equal(plan.length, 0);
});

test('buildProbePlan dedupes identical dom.* invocations across formulas and within one formula', () => {
  let file = emptyFormulasFile();
  file = addFormula(
    file,
    'checkout/confirm',
    and(pred('dom.visible', ['#toast']), pred('dom.visible', ['#toast'])),
    'approved',
  );
  file = addFormula(file, 'checkout/other', eventually(pred('dom.visible', ['#toast'])), 'draft');

  const plan = buildProbePlan(file);

  assert.equal(plan.length, 1);
});

test('buildProbePlan collects nested dom.* nodes from nested temporal/boolean operators', () => {
  let file = emptyFormulasFile();
  file = addFormula(
    file,
    'checkout/confirm',
    not(and(pred('dom.exists', ['#a']), eventually(pred('dom.count', ['.item', 'gte', '2'])))),
    'approved',
  );

  const plan = buildProbePlan(file);

  const predicates = plan.map((p) => p.predicate).sort();
  assert.deepEqual(predicates, ['dom.count', 'dom.exists']);
});

test('buildProbePlan returns empty plan for a formulas file with no dom.* predicates', () => {
  let file = emptyFormulasFile();
  file = addFormula(file, 'checkout/confirm', eventually(pred('http.response', ['/api', '200'])), 'approved');

  const plan = buildProbePlan(file);

  assert.deepEqual(plan, []);
});

test('buildProbePlanWithLog returns the same plan as buildProbePlan', () => {
  let file = emptyFormulasFile();
  file = addFormula(file, 'checkout/confirm', pred('dom.visible', ['#toast']), 'approved');

  const plan = buildProbePlanWithLog(file);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].predicate, 'dom.visible');
});
