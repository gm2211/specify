import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_ONLY_TAG,
  buildScopedGrep,
  findGeneratedTest,
  lastVerifyStatuses,
  routeBehaviors,
  selectTechnique,
  type TechniqueContext,
} from './technique-selector.js';
import { ConfidenceStore, confidenceFor, type ConfidenceRow } from './confidence-store.js';
import type { Spec } from '../spec/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function row(accepts: number, overrides: number): ConfidenceRow {
  return { behaviorId: 'x', accepts, overrides, lastUpdatedAt: '' };
}

const HIGH = row(20, 1); // confidenceFor ≈ 0.909
const LOW = row(1, 5); // confidenceFor ≈ 0.143
const NEUTRAL = row(0, 0); // confidenceFor = 0.5 (no feedback yet)

function ctx(overrides: Partial<TechniqueContext> = {}): TechniqueContext {
  return {
    confidenceRow: HIGH,
    testExists: true,
    lastStatus: 'passed',
    ...overrides,
  };
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-router-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// selectTechnique — policy matrix (confidence x test-exists x last-status x tag)
// ---------------------------------------------------------------------------

test('selectTechnique: high confidence + test exists + last passed → scripted', () => {
  assert.equal(selectTechnique('a/b', ctx()), 'scripted');
});

test('selectTechnique: low confidence → agent even with a fresh passing test', () => {
  assert.equal(selectTechnique('a/b', ctx({ confidenceRow: LOW })), 'agent');
});

test('selectTechnique: neutral 0.5 (no feedback) → agent — safe default for new behaviors', () => {
  assert.equal(confidenceFor(NEUTRAL), 0.5);
  assert.equal(selectTechnique('a/b', ctx({ confidenceRow: NEUTRAL })), 'agent');
});

test('selectTechnique: missing generated test → agent regardless of confidence', () => {
  assert.equal(selectTechnique('a/b', ctx({ testExists: false })), 'agent');
});

test('selectTechnique: last status failed → agent', () => {
  assert.equal(selectTechnique('a/b', ctx({ lastStatus: 'failed' })), 'agent');
});

test('selectTechnique: last status skipped → agent', () => {
  assert.equal(selectTechnique('a/b', ctx({ lastStatus: 'skipped' })), 'agent');
});

test('selectTechnique: no recorded last status → agent', () => {
  assert.equal(selectTechnique('a/b', ctx({ lastStatus: undefined })), 'agent');
});

test('selectTechnique: agent-only tag forces agent even when every other gate passes', () => {
  assert.equal(selectTechnique('a/b', ctx({ tags: [AGENT_ONLY_TAG] })), 'agent');
  assert.equal(selectTechnique('a/b', ctx({ tags: ['ui', AGENT_ONLY_TAG] })), 'agent');
});

test('selectTechnique: unrelated tags do not force agent', () => {
  assert.equal(selectTechnique('a/b', ctx({ tags: ['auth', 'ui'] })), 'scripted');
});

test('selectTechnique: threshold is inclusive and overridable', () => {
  // HIGH ≈ 0.909 — below a 0.95 threshold.
  assert.equal(selectTechnique('a/b', ctx(), { threshold: 0.95 }), 'agent');
  // NEUTRAL = 0.5 exactly — inclusive >= comparison.
  assert.equal(selectTechnique('a/b', ctx({ confidenceRow: NEUTRAL }), { threshold: 0.5 }), 'scripted');
});

// ---------------------------------------------------------------------------
// demotion feedback loop — existing confidence math, no new state
// ---------------------------------------------------------------------------

test('demotion: repeated cross-check mismatches drop a high-confidence behavior back to agent', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const store = new ConfidenceStore(path.join(dir, 'confidence.json'));
    // Build up high confidence: 20 accepts, 0 overrides → 20/21 ≈ 0.95.
    for (let i = 0; i < 20; i++) store.record('area/beh', 'accept');
    assert.equal(selectTechnique('area/beh', ctx({ confidenceRow: store.get('area/beh') })), 'scripted');

    // Repeated cross-check mismatches demote via the EXISTING math
    // (2+ consecutive mismatches each add an override).
    for (let i = 0; i < 30; i++) store.recordFromCrossCheck('area/beh', false);
    const demoted = store.get('area/beh');
    assert.ok(confidenceFor(demoted) < 0.7, `expected demoted confidence < 0.7, got ${confidenceFor(demoted)}`);
    assert.equal(selectTechnique('area/beh', ctx({ confidenceRow: demoted })), 'agent');
  } finally {
    cleanup();
  }
});

test('demotion: feedback overrides route a previously-scripted behavior to agent', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const store = new ConfidenceStore(path.join(dir, 'confidence.json'));
    for (let i = 0; i < 10; i++) store.record('area/beh', 'accept');
    assert.equal(selectTechnique('area/beh', ctx({ confidenceRow: store.get('area/beh') })), 'scripted');
    for (let i = 0; i < 10; i++) store.record('area/beh', 'override');
    assert.equal(selectTechnique('area/beh', ctx({ confidenceRow: store.get('area/beh') })), 'agent');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// buildScopedGrep — alternation + escaping
// ---------------------------------------------------------------------------

test('buildScopedGrep: single id becomes an escaped "<id>:" pattern', () => {
  const grep = buildScopedGrep(['checkout/apply-coupon']);
  assert.ok(grep);
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(grep!);
  assert.ok(re.test('checkout/apply-coupon: applying a valid coupon reduces the total'));
  assert.ok(!re.test('checkout/apply-coupon-twice: double application rejected'));
});

test('buildScopedGrep: multiple ids joined with alternation, each matching only its own title', () => {
  const grep = buildScopedGrep(['a/one', 'b/two']);
  assert.ok(grep);
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(grep!);
  assert.ok(re.test('a/one: first'));
  assert.ok(re.test('b/two: second'));
  assert.ok(!re.test('c/three: third'));
});

test('buildScopedGrep: regex metacharacters in ids are escaped, not interpreted', () => {
  const grep = buildScopedGrep(['area/beh.v2+x']);
  assert.ok(grep);
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(grep!);
  assert.ok(re.test('area/beh.v2+x: exact literal match'));
  // Unescaped, "." would match any char and "+" would quantify — this title
  // must NOT match.
  assert.ok(!re.test('area/behXv2xx: would match if metacharacters were live'));
});

test('buildScopedGrep: empty list → undefined (caller skips the run, never an always-match grep)', () => {
  assert.equal(buildScopedGrep([]), undefined);
});

// ---------------------------------------------------------------------------
// findGeneratedTest / lastVerifyStatuses — on-disk context helpers
// ---------------------------------------------------------------------------

test('findGeneratedTest: finds a behavior title inside a generated spec file, with mtime', () => {
  const { dir, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'gen.spec.ts'), `test('a/one: does the thing', async () => {});\n`);
    const found = findGeneratedTest(dir, 'a/one');
    assert.equal(found.exists, true);
    assert.ok(typeof found.mtimeMs === 'number' && found.mtimeMs > 0);
    assert.equal(findGeneratedTest(dir, 'a/other').exists, false);
  } finally {
    cleanup();
  }
});

test('findGeneratedTest: missing output dir → not found, no throw', () => {
  assert.deepEqual(findGeneratedTest('/nonexistent/definitely/not/here', 'a/b'), { exists: false });
});

test('lastVerifyStatuses: reads statuses from verify-result.json; missing/corrupt → empty', () => {
  const { dir, cleanup } = tmpDir();
  try {
    assert.equal(lastVerifyStatuses(dir).size, 0);
    fs.writeFileSync(
      path.join(dir, 'verify-result.json'),
      JSON.stringify({ structuredOutput: { results: [
        { id: 'a/one', status: 'passed', description: '' },
        { id: 'a/two', status: 'failed', description: '' },
      ] } }),
    );
    const statuses = lastVerifyStatuses(dir);
    assert.equal(statuses.get('a/one'), 'passed');
    assert.equal(statuses.get('a/two'), 'failed');

    fs.writeFileSync(path.join(dir, 'verify-result.json'), 'not json');
    assert.equal(lastVerifyStatuses(dir).size, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// routeBehaviors — full partition, selector policy stubbed via injected rows
// ---------------------------------------------------------------------------

function makeSpec(): Spec {
  return {
    version: '2',
    name: 'routing-test',
    target: { type: 'web', url: 'http://localhost' },
    areas: [
      {
        id: 'checkout',
        name: 'Checkout',
        behaviors: [
          { id: 'apply-coupon', description: 'coupon works' },
          { id: 'free-shipping', description: 'over $50 ships free' },
          { id: 'visual-polish', description: 'looks right', tags: [AGENT_ONLY_TAG] },
        ],
      },
      {
        id: 'auth',
        name: 'Auth',
        behaviors: [{ id: 'login', description: 'login works' }],
      },
    ],
  } as Spec;
}

test('routeBehaviors: partitions per policy and never drops a behavior', () => {
  const { dir, cleanup } = tmpDir();
  try {
    // Generated tests exist for apply-coupon and visual-polish only.
    fs.writeFileSync(
      path.join(dir, 'gen.spec.ts'),
      `test('checkout/apply-coupon: coupon works', async () => {});\ntest('checkout/visual-polish: looks right', async () => {});\n`,
    );
    // Last run: both passed.
    fs.writeFileSync(
      path.join(dir, 'verify-result.json'),
      JSON.stringify({ structuredOutput: { results: [
        { id: 'checkout/apply-coupon', status: 'passed', description: '' },
        { id: 'checkout/visual-polish', status: 'passed', description: '' },
      ] } }),
    );
    // High confidence everywhere — the stubbed store.
    const getRow = (id: string): ConfidenceRow => ({ behaviorId: id, accepts: 20, overrides: 1, lastUpdatedAt: '' });

    const partition = routeBehaviors(makeSpec(), getRow, dir);
    // apply-coupon: all gates pass → scripted.
    assert.deepEqual(partition.scripted, ['checkout/apply-coupon']);
    // free-shipping (no test), login (no test/history), visual-polish (agent-only tag) → agent.
    assert.deepEqual(
      [...partition.agent].sort(),
      ['auth/login', 'checkout/free-shipping', 'checkout/visual-polish'],
    );
    // Coverage: every behavior routed exactly once.
    const all = [...partition.scripted, ...partition.agent].sort();
    assert.deepEqual(all, ['auth/login', 'checkout/apply-coupon', 'checkout/free-shipping', 'checkout/visual-polish']);
  } finally {
    cleanup();
  }
});

test('routeBehaviors: sparse confidence data routes everything to agent (ALL_UNTESTED-safe default)', () => {
  const { dir, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'gen.spec.ts'), `test('checkout/apply-coupon: coupon works', async () => {});\n`);
    fs.writeFileSync(
      path.join(dir, 'verify-result.json'),
      JSON.stringify({ structuredOutput: { results: [{ id: 'checkout/apply-coupon', status: 'passed', description: '' }] } }),
    );
    const neutral = (id: string): ConfidenceRow => ({ behaviorId: id, accepts: 0, overrides: 0, lastUpdatedAt: '' });
    const partition = routeBehaviors(makeSpec(), neutral, dir);
    assert.deepEqual(partition.scripted, []);
    assert.equal(partition.agent.length, 4);
  } finally {
    cleanup();
  }
});
