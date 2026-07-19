import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  collectAllFlows,
  selectFlowCandidates,
  validateDraftResult,
  normalizeSkippedFlow,
  mergeDraftResults,
  draftQuintSpecs,
  type DraftAgentRunner,
} from './quint-draft.js';
import { loadQuintSpecs, emptyQuintSpecsFile, type QuintSpecsFile } from './quint-specs.js';
import type { Spec } from './types.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quint-draft-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function sampleSpec(): Spec {
  return {
    version: '2',
    name: 'Test Spec',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      {
        id: 'auth',
        name: 'Auth',
        behaviors: [
          { id: 'login', description: 'User can log in with valid credentials' },
          { id: 'logout', description: 'User can log out' },
        ],
      },
      { id: 'dashboard', name: 'Dashboard', behaviors: [{ id: 'layout', description: 'Dashboard looks clean' }] },
    ],
  };
}

function writeSpecFixture(dir: string): string {
  const specPath = path.join(dir, 'spec.yaml');
  fs.writeFileSync(
    specPath,
    [
      'version: "2"',
      'name: Test Spec',
      'target:',
      '  type: web',
      '  url: http://localhost:3000',
      'areas:',
      '  - id: auth',
      '    name: Auth',
      '    behaviors:',
      '      - id: login',
      '        description: User can log in with valid credentials',
      '      - id: logout',
      '        description: User can log out',
      '',
    ].join('\n'),
    'utf-8',
  );
  return specPath;
}

/** Run a body with SPECIFY_ENABLE_QUINT_SPECS forced to a value, then restore. */
async function withFlag(value: string | undefined, body: () => Promise<void>): Promise<void> {
  const prev = process.env.SPECIFY_ENABLE_QUINT_SPECS;
  if (value === undefined) delete process.env.SPECIFY_ENABLE_QUINT_SPECS;
  else process.env.SPECIFY_ENABLE_QUINT_SPECS = value;
  try {
    await body();
  } finally {
    if (prev === undefined) delete process.env.SPECIFY_ENABLE_QUINT_SPECS;
    else process.env.SPECIFY_ENABLE_QUINT_SPECS = prev;
  }
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test('collectAllFlows flattens areas/behaviors', () => {
  assert.deepEqual(
    collectAllFlows(sampleSpec()).map((f) => f.fqId),
    ['auth/login', 'auth/logout', 'dashboard/layout'],
  );
});

test('selectFlowCandidates excludes already-drafted flows unless forced', () => {
  const all = collectAllFlows(sampleSpec());
  const existing: QuintSpecsFile = {
    version: 1,
    specs: [
      {
        id: 'qnt-x',
        flow: 'auth/login',
        description_hash: 'sha256:x',
        spec_text: 'module auth {}',
        predicates_used: [],
        status: 'draft',
        provenance: { drafted_by: 'llm', drafted_at: 't' },
      },
    ],
  };
  assert.deepEqual(
    selectFlowCandidates(all, existing, undefined, false).map((f) => f.fqId),
    ['auth/logout', 'dashboard/layout'],
  );
  // Forced: everything is a candidate again.
  assert.equal(selectFlowCandidates(all, existing, undefined, true).length, 3);
  // Filter narrows to a specific flow.
  assert.deepEqual(
    selectFlowCandidates(all, null, ['auth/login'], false).map((f) => f.fqId),
    ['auth/login'],
  );
});

test('validateDraftResult: accepts a valid module, filters ungrounded predicate names', () => {
  const valid = new Set(['auth/login']);
  const preds = new Set(['page.url', 'http.response']);
  const v = validateDraftResult(
    { flow: 'auth/login', spec_text: 'module auth { var url: str }', predicates_used: ['page.url', 'bogus.pred'], rationale: 'r' },
    valid,
    preds,
  );
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.deepEqual(v.predicatesUsed, ['page.url']);
    assert.deepEqual(v.ungroundedPredicates, ['bogus.pred']);
  }
});

test('validateDraftResult: rejects unknown flow, empty text, and non-module text', () => {
  const valid = new Set(['auth/login']);
  const preds = new Set(['page.url']);
  assert.equal(validateDraftResult({ flow: 'nope/x', spec_text: 'module x {}' }, valid, preds).ok, false);
  assert.equal(validateDraftResult({ flow: 'auth/login', spec_text: '' }, valid, preds).ok, false);
  assert.equal(validateDraftResult({ flow: 'auth/login', spec_text: 'not a spec' }, valid, preds).ok, false);
});

test('normalizeSkippedFlow tolerates malformed entries', () => {
  assert.deepEqual(normalizeSkippedFlow({ flow: 'a/b', reason: 'x' }), { flow: 'a/b', reason: 'x' });
  assert.deepEqual(normalizeSkippedFlow({ flow: 'a/b' }), { flow: 'a/b', reason: '(no reason given)' });
  assert.equal(normalizeSkippedFlow({}), null);
});

test('mergeDraftResults dedupes identical specs', () => {
  const r = { flow: 'auth/login', specText: 'module auth {}', predicatesUsed: ['page.url'], rationale: 'r', description: 'd' };
  const first = mergeDraftResults(emptyQuintSpecsFile(), [r], { drafted_by: 'llm' });
  assert.equal(first.added.length, 1);
  const second = mergeDraftResults(first.file, [r], { drafted_by: 'llm' });
  assert.equal(second.added.length, 0);
  assert.deepEqual(second.deduped, ['auth/login']);
});

// ---------------------------------------------------------------------------
// Orchestrator (stubbed agent)
// ---------------------------------------------------------------------------

test('draftQuintSpecs: no-op with a clear reason when the flag is off', async () => {
  await withFlag(undefined, async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const specPath = writeSpecFixture(dir);
      const summary = await draftQuintSpecs({ spec: specPath }, { agentRunner: async () => { throw new Error('should not run'); } });
      assert.ok(summary.skippedReason && summary.skippedReason.includes('opt-in'));
      assert.equal(summary.added.length, 0);
    } finally {
      cleanup();
    }
  });
});

test('draftQuintSpecs: writes valid drafts, rejects invalid, records skips (stubbed agent)', async () => {
  await withFlag('1', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const specPath = writeSpecFixture(dir);
      const stub: DraftAgentRunner = async () => ({
        model: 'stub-model',
        sessionId: 'sess-1',
        costUsd: 0.02,
        output: {
          results: [
            { flow: 'auth/login', spec_text: 'module auth { var url: str }', predicates_used: ['page.url'], rationale: 'models the login flow' },
            { flow: 'auth/logout', spec_text: 'garbage text with no declaration', predicates_used: [], rationale: 'bad' },
          ],
          skipped: [{ flow: 'dashboard/layout', reason: 'subjective' }],
        },
      });

      const quintPath = path.join(dir, 'specify.quint.yaml');
      assert.ok(!fs.existsSync(quintPath));

      const summary = await draftQuintSpecs({ spec: specPath }, { agentRunner: stub });
      assert.equal(summary.skippedReason, undefined);
      assert.deepEqual(summary.added.map((a) => a.flow), ['auth/login']);
      assert.equal(summary.rejected.length, 1);
      assert.equal(summary.rejected[0].flow, 'auth/logout');

      const written = loadQuintSpecs(quintPath) as QuintSpecsFile;
      assert.equal(written.specs.length, 1);
      assert.equal(written.specs[0].flow, 'auth/login');
      assert.equal(written.specs[0].status, 'draft');
      assert.equal(written.specs[0].provenance.model, 'stub-model');
      assert.equal(written.specs[0].provenance.session_id, 'sess-1');
    } finally {
      cleanup();
    }
  });
});

test('draftQuintSpecs: idempotent re-run drafts nothing new', async () => {
  await withFlag('1', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const specPath = writeSpecFixture(dir);
      const stub: DraftAgentRunner = async () => ({
        model: 'stub-model',
        costUsd: 0,
        output: {
          results: [{ flow: 'auth/login', spec_text: 'module auth {}', predicates_used: [], rationale: 'r' }],
          skipped: [],
        },
      });
      await draftQuintSpecs({ spec: specPath }, { agentRunner: stub });
      const second = await draftQuintSpecs({ spec: specPath }, { agentRunner: stub });
      // auth/login already drafted → excluded as a candidate; only auth/logout remains,
      // which the stub doesn't return, so nothing is added.
      assert.equal(second.added.length, 0);
    } finally {
      cleanup();
    }
  });
});

test('draftQuintSpecs: surfaces ungrounded predicates from a valid draft', async () => {
  await withFlag('1', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const specPath = writeSpecFixture(dir);
      const stub: DraftAgentRunner = async () => ({
        model: 'm',
        costUsd: 0,
        output: {
          results: [
            { flow: 'auth/login', spec_text: 'module auth {}', predicates_used: ['page.url', 'made.up.pred'], rationale: 'r' },
          ],
          skipped: [],
        },
      });
      const summary = await draftQuintSpecs({ spec: specPath }, { agentRunner: stub });
      assert.equal(summary.added.length, 1);
      assert.deepEqual(summary.ungrounded, [{ flow: 'auth/login', predicates: ['made.up.pred'] }]);
    } finally {
      cleanup();
    }
  });
});
