import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Spec } from '../../spec/types.js';
import {
  addDraft,
  emptyFormulasFile,
  hashDescription,
  type FormulasFile,
} from '../../spec/formulas.js';
import { pred, eventually, implies, globally, type Formula } from '../../monitor/formula.js';
import {
  collectAllBehaviors,
  selectCandidates,
  validateCompileResult,
  normalizeSkipped,
  mergeCompiledResults,
  specCompile,
  type RawCompileResult,
  type CompileAgentRunner,
} from './spec-compile.js';
import type { CliContext } from '../types.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-spec-compile-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
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
      {
        id: 'dashboard',
        name: 'Dashboard',
        behaviors: [{ id: 'layout', description: 'Dashboard layout looks clean and modern' }],
      },
    ],
  };
}

function quietCtx(): CliContext {
  return { outputFormat: 'json', quiet: true };
}

const PREDICATE_NAMES = new Set(['http.response', 'step.action', 'page.url']);

// ---------------------------------------------------------------------------
// collectAllBehaviors / selectCandidates
// ---------------------------------------------------------------------------

test('collectAllBehaviors flattens areas into fully-qualified ids', () => {
  const behaviors = collectAllBehaviors(sampleSpec());
  assert.deepEqual(behaviors.map((b) => b.fqId), ['auth/login', 'auth/logout', 'dashboard/layout']);
});

test('selectCandidates excludes already-compiled behaviors by default', () => {
  const spec = sampleSpec();
  const all = collectAllBehaviors(spec);
  const formula = eventually(pred('http.response', ['200']));
  const { file: existing } = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in with valid credentials'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'llm', compiled_at: '2026-01-01T00:00:00Z' },
  });

  const candidates = selectCandidates(all, existing, undefined, false);
  assert.deepEqual(candidates.map((c) => c.fqId), ['auth/logout', 'dashboard/layout']);
});

test('selectCandidates includes already-compiled behaviors when force is set', () => {
  const spec = sampleSpec();
  const all = collectAllBehaviors(spec);
  const formula = eventually(pred('http.response', ['200']));
  const { file: existing } = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in with valid credentials'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'llm', compiled_at: '2026-01-01T00:00:00Z' },
  });

  const candidates = selectCandidates(all, existing, undefined, true);
  assert.deepEqual(candidates.map((c) => c.fqId), ['auth/login', 'auth/logout', 'dashboard/layout']);
});

test('selectCandidates applies a --behavior filter', () => {
  const all = collectAllBehaviors(sampleSpec());
  const candidates = selectCandidates(all, null, ['auth/logout'], false);
  assert.deepEqual(candidates.map((c) => c.fqId), ['auth/logout']);
});

// ---------------------------------------------------------------------------
// validateCompileResult
// ---------------------------------------------------------------------------

test('validateCompileResult accepts a well-formed result', () => {
  const behaviors = new Map([['auth/login', 'User can log in with valid credentials']]);
  const raw: RawCompileResult = {
    behavior: 'auth/login',
    formula: eventually(pred('http.response', ['200'])),
    predicates_used: ['http.response'],
    rationale: 'Login eventually results in a 200 response.',
  };
  const result = validateCompileResult(raw, behaviors, PREDICATE_NAMES);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.behavior, 'auth/login');
    assert.deepEqual(result.predicatesUsed, ['http.response']);
  }
});

test('validateCompileResult rejects an unresolvable behavior id', () => {
  const behaviors = new Map([['auth/login', 'User can log in']]);
  const raw: RawCompileResult = {
    behavior: 'auth/nonexistent',
    formula: eventually(pred('http.response', ['200'])),
    predicates_used: ['http.response'],
    rationale: 'x',
  };
  const result = validateCompileResult(raw, behaviors, PREDICATE_NAMES);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /does not resolve/);
  }
});

test('validateCompileResult rejects a malformed formula (schema failure)', () => {
  const behaviors = new Map([['auth/login', 'User can log in']]);
  const raw: RawCompileResult = {
    behavior: 'auth/login',
    formula: { op: 'not_a_real_op' },
    predicates_used: [],
    rationale: 'x',
  };
  const result = validateCompileResult(raw, behaviors, PREDICATE_NAMES);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /schema validation/);
  }
});

test('validateCompileResult rejects predicates_used referencing an unknown predicate', () => {
  const behaviors = new Map([['auth/login', 'User can log in']]);
  const raw: RawCompileResult = {
    behavior: 'auth/login',
    formula: eventually(pred('http.response', ['200'])),
    predicates_used: ['http.response', 'made.up.predicate'],
    rationale: 'x',
  };
  const result = validateCompileResult(raw, behaviors, PREDICATE_NAMES);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /unknown predicate/);
  }
});

test('validateCompileResult rejects a formula whose actual predicates are unknown even if predicates_used lies', () => {
  const behaviors = new Map([['auth/login', 'User can log in']]);
  const raw: RawCompileResult = {
    behavior: 'auth/login',
    // formula references a bogus predicate the model didn't declare
    formula: eventually(pred('totally.bogus', ['x'])),
    predicates_used: ['http.response'],
    rationale: 'x',
  };
  const result = validateCompileResult(raw, behaviors, PREDICATE_NAMES);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not in predicates_used/);
  }
});

test('normalizeSkipped requires a string behavior', () => {
  assert.equal(normalizeSkipped({ reason: 'no id' }), null);
  const withReason = normalizeSkipped({ behavior: 'dashboard/layout', reason: 'subjective UX judgment' });
  assert.deepEqual(withReason, { behavior: 'dashboard/layout', reason: 'subjective UX judgment' });
  const withoutReason = normalizeSkipped({ behavior: 'dashboard/layout' });
  assert.deepEqual(withoutReason, { behavior: 'dashboard/layout', reason: '(no reason given)' });
});

// ---------------------------------------------------------------------------
// mergeCompiledResults
// ---------------------------------------------------------------------------

test('mergeCompiledResults appends new drafts with llm provenance', () => {
  const outcome = mergeCompiledResults(emptyFormulasFile(), [
    {
      behavior: 'auth/login',
      formula: eventually(pred('http.response', ['200'])),
      predicatesUsed: ['http.response'],
      rationale: 'x',
      description: 'User can log in',
    },
  ], { compiled_by: 'llm', model: 'test-model', compiled_at: '2026-01-01T00:00:00Z' });

  assert.equal(outcome.added.length, 1);
  assert.equal(outcome.file.formulas.length, 1);
  assert.equal(outcome.file.formulas[0].status, 'draft');
  assert.equal(outcome.file.formulas[0].provenance.compiled_by, 'llm');
  assert.equal(outcome.file.formulas[0].provenance.model, 'test-model');
});

test('mergeCompiledResults dedupes structurally identical formulas for the same behavior', () => {
  const formula = eventually(pred('http.response', ['200']));
  const { file: existing } = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'llm', compiled_at: '2026-01-01T00:00:00Z' },
  });

  const outcome = mergeCompiledResults(existing, [
    { behavior: 'auth/login', formula, predicatesUsed: ['http.response'], rationale: 'x', description: 'User can log in' },
  ], { compiled_by: 'llm', compiled_at: '2026-01-02T00:00:00Z' });

  assert.equal(outcome.added.length, 0);
  assert.deepEqual(outcome.deduped, ['auth/login']);
  assert.equal(outcome.file.formulas.length, 1);
});

// ---------------------------------------------------------------------------
// specCompile end-to-end with a stubbed agent runner
// ---------------------------------------------------------------------------

function writeSpecFixture(dir: string): string {
  const specPath = path.join(dir, 'spec.yaml');
  writeFile(specPath, [
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
    '  - id: dashboard',
    '    name: Dashboard',
    '    behaviors:',
    '      - id: layout',
    '        description: Dashboard layout looks clean and modern',
    '',
  ].join('\n'));
  return specPath;
}

test('specCompile writes valid drafts, rejects invalid ones, and records skips (stubbed agent)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = writeSpecFixture(dir);

    const stubRunner: CompileAgentRunner = async () => ({
      model: 'stub-model',
      sessionId: 'sess-1',
      costUsd: 0.01,
      output: {
        results: [
          {
            behavior: 'auth/login',
            formula: eventually(pred('http.response', ['200'])),
            predicates_used: ['http.response'],
            rationale: 'Login eventually yields a 200.',
          },
          {
            // invalid: unknown predicate
            behavior: 'auth/logout',
            formula: eventually(pred('made.up', [])),
            predicates_used: ['made.up'],
            rationale: 'bogus',
          },
        ],
        skipped: [
          { behavior: 'dashboard/layout', reason: 'Subjective UX judgment — not machine-checkable.' },
        ],
      },
    });

    const exitCode = await specCompile({ spec: specPath }, quietCtx(), { agentRunner: stubRunner });
    assert.equal(exitCode, 0);

    const formulasPath = path.join(dir, 'specify.formulas.yaml');
    assert.ok(fs.existsSync(formulasPath), 'formulas file should be written');

    const { loadFormulas } = await import('../../spec/formulas.js');
    const written = loadFormulas(formulasPath) as FormulasFile;
    assert.equal(written.formulas.length, 1);
    assert.equal(written.formulas[0].behavior, 'auth/login');
    assert.equal(written.formulas[0].provenance.compiled_by, 'llm');
    assert.equal(written.formulas[0].provenance.model, 'stub-model');
    assert.equal(written.formulas[0].provenance.session_id, 'sess-1');
    assert.equal(written.formulas[0].status, 'draft');
  } finally {
    cleanup();
  }
});

test('specCompile is idempotent: a re-run excludes already-compiled behaviors from the prompt entirely', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = writeSpecFixture(dir);

    const candidateCountsPerCall: number[] = [];
    const behaviorIdsPerCall: string[][] = [];
    const stubRunner: CompileAgentRunner = async (params) => {
      const ids = [...params.specYaml.matchAll(/- id:\s*(\S+)/g)].map((m) => m[1]);
      behaviorIdsPerCall.push(ids);
      candidateCountsPerCall.push(ids.length);
      return {
        model: 'stub-model',
        costUsd: 0,
        output: {
          results: [
            {
              behavior: 'auth/login',
              formula: eventually(pred('http.response', ['200'])),
              predicates_used: ['http.response'],
              rationale: 'x',
            },
          ],
          // Everything else this run is honestly skipped — skips are not
          // persisted anywhere, so they remain candidates on the next run
          // (only a written formula entry removes a behavior from the
          // candidate set without --force).
          skipped: params.specYaml.includes('logout')
            ? [{ behavior: 'auth/logout', reason: 'skip' }, { behavior: 'dashboard/layout', reason: 'skip' }]
            : [{ behavior: 'dashboard/layout', reason: 'skip' }],
        },
      };
    };

    const first = await specCompile({ spec: specPath }, quietCtx(), { agentRunner: stubRunner });
    assert.equal(first, 0);
    assert.equal(candidateCountsPerCall.length, 1);

    const second = await specCompile({ spec: specPath }, quietCtx(), { agentRunner: stubRunner });
    assert.equal(second, 0);
    assert.equal(candidateCountsPerCall.length, 2, 'second run still has skipped candidates left to (re-)ask about');

    // The key idempotence guarantee: auth/login (which now has a written
    // formula entry) never reappears in a later prompt's behavior set.
    assert.ok(!behaviorIdsPerCall[1].includes('login'), 'already-compiled behavior must be excluded from the second prompt');
    assert.ok(behaviorIdsPerCall[0].includes('login'), 'first prompt should have included it before it was compiled');

    const { loadFormulas } = await import('../../spec/formulas.js');
    const written = loadFormulas(path.join(dir, 'specify.formulas.yaml')) as FormulasFile;
    // Still exactly one formula for auth/login — the second run did not
    // recompile or duplicate it.
    assert.equal(written.formulas.filter((f) => f.behavior === 'auth/login').length, 1);
  } finally {
    cleanup();
  }
});

test('specCompile with all behaviors already compiled short-circuits without invoking the agent', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = writeSpecFixture(dir);

    let callCount = 0;
    const stubRunner: CompileAgentRunner = async () => {
      callCount++;
      return {
        model: 'stub-model',
        costUsd: 0,
        output: {
          results: [
            { behavior: 'auth/login', formula: eventually(pred('http.response', ['200'])), predicates_used: ['http.response'], rationale: 'x' },
            { behavior: 'auth/logout', formula: eventually(pred('http.response', ['200'])), predicates_used: ['http.response'], rationale: 'x' },
            { behavior: 'dashboard/layout', formula: eventually(pred('http.response', ['200'])), predicates_used: ['http.response'], rationale: 'x' },
          ],
          skipped: [],
        },
      };
    };

    const first = await specCompile({ spec: specPath }, quietCtx(), { agentRunner: stubRunner });
    assert.equal(first, 0);
    assert.equal(callCount, 1);

    const second = await specCompile({ spec: specPath }, quietCtx(), { agentRunner: stubRunner });
    assert.equal(second, 0);
    assert.equal(callCount, 1, 'nothing left to compile — the agent must not be invoked again');
  } finally {
    cleanup();
  }
});

test('specCompile --force recompiles a behavior that already has a formula', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = writeSpecFixture(dir);

    const makeRunner = (formula: Formula): CompileAgentRunner => async () => ({
      model: 'stub-model',
      costUsd: 0,
      output: {
        results: [
          { behavior: 'auth/login', formula, predicates_used: ['http.response'], rationale: 'x' },
        ],
        skipped: [
          { behavior: 'auth/logout', reason: 'skip' },
          { behavior: 'dashboard/layout', reason: 'skip' },
        ],
      },
    });

    await specCompile({ spec: specPath }, quietCtx(), {
      agentRunner: makeRunner(eventually(pred('http.response', ['200']))),
    });

    const forced = await specCompile({ spec: specPath, force: true }, quietCtx(), {
      agentRunner: makeRunner(globally(implies(pred('step.action', ['click']), eventually(pred('http.response', ['200']))))),
    });
    assert.equal(forced, 0);

    const { loadFormulas } = await import('../../spec/formulas.js');
    const written = loadFormulas(path.join(dir, 'specify.formulas.yaml')) as FormulasFile;
    const loginFormulas = written.formulas.filter((f) => f.behavior === 'auth/login');
    // --force recompiled with a structurally different formula, so both entries exist.
    assert.equal(loginFormulas.length, 2);
  } finally {
    cleanup();
  }
});
