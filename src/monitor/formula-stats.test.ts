/**
 * src/monitor/formula-stats.test.ts — Pure record-function tests plus a
 * round-trip on the atomic load/save file boundary.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyRecompileDemotions,
  DRIFT_WINDOW,
  emptyFormulaStatsFile,
  isPromotionCandidate,
  loadFormulaStats,
  PROMOTION_STREAK,
  recordFormulaVerdict,
  saveFormulaStats,
  type FormulaStatsFile,
} from './formula-stats.js';
import { emptyFormulasFile, type FormulaEntry, type FormulasFile } from '../spec/formulas.js';
import { pred } from './formula.js';

function tmpFile(): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-fstats-'));
  const filePath = path.join(dir, 'formula-stats.json');
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function record(
  file: FormulaStatsFile,
  overrides: Partial<Parameters<typeof recordFormulaVerdict>[1]> = {},
) {
  return recordFormulaVerdict(file, {
    formulaId: 'fml-abc',
    formulaStatus: 'draft',
    verdict: 'satisfied',
    llmStatus: 'passed',
    vacuous: false,
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Basic tallying
// ---------------------------------------------------------------------------

test('recordFormulaVerdict: tallies verdict counts and is pure (does not mutate the input file)', () => {
  const file = emptyFormulaStatsFile();
  const r1 = record(file, { verdict: 'satisfied' });
  assert.equal(Object.keys(file.rows).length, 0, 'input file untouched');
  assert.equal(r1.row.satisfied, 1);
  assert.equal(r1.row.runsSeen, 1);

  const r2 = record(r1.file, { verdict: 'violated', llmStatus: 'failed' });
  assert.equal(r2.row.satisfied, 1);
  assert.equal(r2.row.violated, 1);
  assert.equal(r2.row.runsSeen, 2);
});

// ---------------------------------------------------------------------------
// Shadow-mode agreement / promotion streak
// ---------------------------------------------------------------------------

test('shadow-mode agreement streak: promote suggestion fires exactly when the streak crosses the threshold', () => {
  let file = emptyFormulaStatsFile();
  let lastResult;
  for (let i = 0; i < PROMOTION_STREAK; i++) {
    lastResult = record(file, { verdict: 'satisfied', llmStatus: 'passed' });
    file = lastResult.file;
    if (i < PROMOTION_STREAK - 1) {
      assert.equal(lastResult.promotionJustSuggested, false, `should not fire before streak ${i + 1}`);
    }
  }
  assert.equal(lastResult!.promotionJustSuggested, true, 'fires exactly on the crossing run');
  assert.equal(lastResult!.row.consecutiveAgreements, PROMOTION_STREAK);
  assert.ok(isPromotionCandidate(lastResult!.row));

  // One more agreement keeps the candidate flag true but does not re-fire "just suggested".
  const again = record(file, { verdict: 'satisfied', llmStatus: 'passed' });
  assert.equal(again.promotionJustSuggested, false);
  assert.ok(isPromotionCandidate(again.row));
});

test('a single disagreement resets the consecutive-agreement streak to 0', () => {
  let file = emptyFormulaStatsFile();
  for (let i = 0; i < PROMOTION_STREAK - 1; i++) {
    file = record(file, { verdict: 'satisfied', llmStatus: 'passed' }).file;
  }
  const disagreed = record(file, { verdict: 'satisfied', llmStatus: 'failed' });
  assert.equal(disagreed.row.consecutiveAgreements, 0);
  assert.equal(disagreed.row.disagreements, 1);
  assert.equal(disagreed.promotionJustSuggested, false);
});

test('vacuous satisfied verdicts are neutral: neither agreement nor disagreement, streak untouched', () => {
  let file = emptyFormulaStatsFile();
  file = record(file, { verdict: 'satisfied', llmStatus: 'passed' }).file; // streak 1
  const vacuous = record(file, { verdict: 'satisfied', llmStatus: 'passed', vacuous: true });
  assert.equal(vacuous.row.consecutiveAgreements, 1, 'streak neither advances nor resets');
  assert.equal(vacuous.row.agreements, 1, 'no new agreement counted');
  assert.equal(vacuous.row.disagreements, 0);
  assert.equal(vacuous.row.vacuousSatisfied, 1);
  assert.equal(vacuous.row.satisfied, 2, 'still tallied as a satisfied verdict');
});

test('inconclusive / unevaluable verdicts are neutral and do not reset the streak', () => {
  let file = emptyFormulaStatsFile();
  file = record(file, { verdict: 'satisfied', llmStatus: 'passed' }).file;
  const inconclusive = record(file, { verdict: 'inconclusive', llmStatus: 'passed' });
  assert.equal(inconclusive.row.consecutiveAgreements, 1);
  assert.equal(inconclusive.row.agreements, 1);
  const unevaluable = record(inconclusive.file, { verdict: 'unevaluable', llmStatus: 'passed' });
  assert.equal(unevaluable.row.consecutiveAgreements, 1);
});

// ---------------------------------------------------------------------------
// Grounding drift
// ---------------------------------------------------------------------------

test('drift: a formula that was grounded then goes mostly unevaluable gets flagged', () => {
  let file = emptyFormulaStatsFile();
  // Establish groundedness first (recentVerdicts: ['satisfied'], length 1).
  file = record(file, { formulaId: 'fml-drift', verdict: 'satisfied', llmStatus: 'passed' }).file;
  // DRIFT_WINDOW - 1 more pushes brings the ring buffer to exactly
  // DRIFT_WINDOW entries on the last iteration — the first run the window
  // is full enough to judge.
  let result;
  for (let i = 0; i < DRIFT_WINDOW - 1; i++) {
    result = record(file, { formulaId: 'fml-drift', verdict: 'unevaluable', llmStatus: 'passed' });
    file = result.file;
  }
  assert.equal(result!.row.driftFlagged, true);
  assert.ok(result!.row.driftDetectedAt);
  assert.equal(result!.driftJustDetected, true, 'fires on the exact run that crosses the window/threshold');

  // Further unevaluable runs don't re-fire "just detected" (sticky flag).
  const again = record(file, { formulaId: 'fml-drift', verdict: 'unevaluable', llmStatus: 'passed' });
  assert.equal(again.driftJustDetected, false);
  assert.equal(again.row.driftFlagged, true);
});

test('drift: never-grounded formula does not flag drift merely for being unevaluable a lot', () => {
  let file = emptyFormulaStatsFile();
  let result;
  for (let i = 0; i < DRIFT_WINDOW + 2; i++) {
    result = record(file, { formulaId: 'fml-never-grounded', verdict: 'unevaluable', llmStatus: 'passed' });
    file = result.file;
  }
  assert.equal(result!.row.groundedSeen, false);
  assert.equal(result!.row.driftFlagged, false, 'never having produced a determinate verdict is not drift');
});

test('drift: a healthy mix of satisfied/violated below the threshold does not flag', () => {
  let file = emptyFormulaStatsFile();
  let result;
  for (let i = 0; i < DRIFT_WINDOW; i++) {
    const verdict = i % 2 === 0 ? 'satisfied' : 'violated';
    result = record(file, {
      formulaId: 'fml-healthy',
      verdict,
      llmStatus: verdict === 'satisfied' ? 'passed' : 'failed',
    });
    file = result.file;
  }
  assert.equal(result!.row.driftFlagged, false);
});

// ---------------------------------------------------------------------------
// Recompile-on-disagreement (approved formulas)
// ---------------------------------------------------------------------------

test('recompile flag: an approved formula satisfied while the LLM failed gets flagged, once, stickily', () => {
  const file = emptyFormulaStatsFile();
  const first = record(file, {
    formulaId: 'fml-approved',
    formulaStatus: 'approved',
    verdict: 'satisfied',
    llmStatus: 'failed',
  });
  assert.equal(first.row.recompileFlagged, true);
  assert.equal(first.recompileJustFlagged, true);
  assert.ok(first.row.recompileFlaggedAt);

  const second = record(first.file, {
    formulaId: 'fml-approved',
    formulaStatus: 'approved',
    verdict: 'satisfied',
    llmStatus: 'failed',
  });
  assert.equal(second.recompileJustFlagged, false, 'already flagged — does not re-fire');
});

test('recompile flag: violated while the LLM passed does NOT flag — the asymmetric policy already acts on it', () => {
  const result = record(emptyFormulaStatsFile(), {
    formulaId: 'fml-working',
    formulaStatus: 'approved',
    verdict: 'violated',
    llmStatus: 'passed',
  });
  assert.equal(result.row.recompileFlagged, false, 'a violation the LLM missed is the formula WORKING, not drifting');
  assert.equal(result.recompileJustFlagged, false);
  assert.equal(result.row.disagreements, 1, 'still a disagreement for streak purposes');
  assert.equal(result.row.consecutiveAgreements, 0);
});

test('recompile flag: a vacuous satisfied pass while the LLM failed does not flag', () => {
  const result = record(emptyFormulaStatsFile(), {
    formulaId: 'fml-vacuous',
    formulaStatus: 'approved',
    verdict: 'satisfied',
    llmStatus: 'failed',
    vacuous: true,
  });
  assert.equal(result.row.recompileFlagged, false);
  assert.equal(result.recompileJustFlagged, false);
});

test('llmStatus skipped is neutral: no streak advance, no streak reset, no recompile flag', () => {
  let file = emptyFormulaStatsFile();
  file = record(file, { verdict: 'satisfied', llmStatus: 'passed' }).file; // streak 1
  const skipped = record(file, { verdict: 'satisfied', llmStatus: 'skipped' });
  assert.equal(skipped.row.consecutiveAgreements, 1, 'streak neither advances nor resets');
  assert.equal(skipped.row.agreements, 1);
  assert.equal(skipped.row.disagreements, 0);

  const skippedViolated = record(skipped.file, {
    formulaId: 'fml-abc',
    formulaStatus: 'approved',
    verdict: 'violated',
    llmStatus: 'skipped',
  });
  assert.equal(skippedViolated.row.consecutiveAgreements, 1, 'violated + skipped is also neutral');
  assert.equal(skippedViolated.row.disagreements, 0);
  assert.equal(skippedViolated.row.recompileFlagged, false);
});

test('recompile flag: draft formulas never set it, even on the equivalent disagreement shape', () => {
  const result = record(emptyFormulaStatsFile(), {
    formulaId: 'fml-draft-only',
    formulaStatus: 'draft',
    verdict: 'satisfied',
    llmStatus: 'failed',
  });
  assert.equal(result.row.recompileFlagged, false);
  assert.equal(result.row.disagreements, 1, 'still tallied as a shadow-mode disagreement');
});

// ---------------------------------------------------------------------------
// applyRecompileDemotions
// ---------------------------------------------------------------------------

function approvedEntry(id: string): FormulaEntry {
  return {
    id,
    behavior: 'area/behavior',
    description_hash: 'sha256:0',
    formula: pred('x'),
    predicates_used: ['x'],
    status: 'approved',
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  };
}

test('applyRecompileDemotions: demotes only approved formulas with recompileFlagged set', () => {
  const formulasFile: FormulasFile = {
    ...emptyFormulasFile(),
    formulas: [approvedEntry('fml-a'), approvedEntry('fml-b')],
  };
  const statsFile = record(emptyFormulaStatsFile(), {
    formulaId: 'fml-a',
    formulaStatus: 'approved',
    verdict: 'satisfied',
    llmStatus: 'failed',
  }).file;

  const { file, demoted } = applyRecompileDemotions(formulasFile, statsFile);
  assert.deepEqual(demoted, ['fml-a']);
  assert.equal(file.formulas.find((f) => f.id === 'fml-a')!.status, 'draft');
  assert.equal(file.formulas.find((f) => f.id === 'fml-b')!.status, 'approved');
});

test('applyRecompileDemotions: no-op when nothing is flagged', () => {
  const formulasFile: FormulasFile = { ...emptyFormulasFile(), formulas: [approvedEntry('fml-a')] };
  const { demoted } = applyRecompileDemotions(formulasFile, emptyFormulaStatsFile());
  assert.deepEqual(demoted, []);
});

// ---------------------------------------------------------------------------
// Atomic load/save round-trip
// ---------------------------------------------------------------------------

test('saveFormulaStats + loadFormulaStats round-trip via tmp+rename', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    const file = record(emptyFormulaStatsFile(), { formulaId: 'fml-x' }).file;
    saveFormulaStats(filePath, file);
    assert.ok(fs.existsSync(filePath));
    assert.ok(!fs.existsSync(`${filePath}.tmp`), 'tmp file renamed away, not left behind');

    const reloaded = loadFormulaStats(filePath);
    assert.equal(reloaded.rows['fml-x'].satisfied, 1);
  } finally {
    cleanup();
  }
});

test('loadFormulaStats: missing file returns an empty file rather than throwing', () => {
  const result = loadFormulaStats('/nonexistent/dir/formula-stats.json');
  assert.deepEqual(result, emptyFormulaStatsFile());
});

test('loadFormulaStats: corrupt JSON returns an empty file rather than throwing', () => {
  const { filePath, cleanup } = tmpFile();
  try {
    fs.writeFileSync(filePath, '{ not valid json', 'utf-8');
    const result = loadFormulaStats(filePath);
    assert.deepEqual(result, emptyFormulaStatsFile());
  } finally {
    cleanup();
  }
});
