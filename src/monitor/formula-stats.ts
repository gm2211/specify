/**
 * src/monitor/formula-stats.ts — Per-formula run-over-run telemetry.
 *
 * WHY: the compile pipeline (SP-c0n, SP-7lv) gives every formula a lifecycle
 * — draft (shadow mode, advisory-only) -> approved (gates verdicts) ->
 * rejected — but nothing tracked EVIDENCE for those transitions. Without
 * telemetry, a draft formula never earns promotion beyond "a human eyeballed
 * it once", and an approved formula's predicates can silently stop being
 * grounded (an app redesign moves a selector) with no signal beyond "verify
 * quietly got less useful".
 *
 * This module tracks three things, purely (no I/O in the record function —
 * see loadFormulaStats/saveFormulaStats for the atomic file boundary):
 *
 *   1. SHADOW-MODE AGREEMENT: does a draft formula's verdict track the LLM's
 *      independent judgement call? A sustained streak of agreement
 *      (PROMOTION_STREAK consecutive) is evidence-backed grounds to suggest
 *      promoting draft -> approved. A single disagreement resets the streak
 *      — occasional noise is expected; only sustained agreement counts.
 *
 *   2. GROUNDING DRIFT: once a formula has demonstrated it CAN produce a
 *      determinate verdict (satisfied or violated at least once —
 *      `groundedSeen`), a run of mostly inconclusive/unevaluable verdicts
 *      (DRIFT_WINDOW-run sliding window, DRIFT_THRESHOLD fraction) means its
 *      predicates likely stopped resolving against the app (a renamed
 *      selector, a moved endpoint) — NOT ordinary truncation noise, because
 *      it used to work. Flags the formula for re-grounding: an LLM re-maps
 *      the predicate against the current UI, a human approves, the formula
 *      version bumps. This module only raises the flag; the re-map/approve
 *      flow itself is a review-server / webapp concern.
 *
 *   3. RECOMPILE-ON-DISAGREEMENT: any run where an APPROVED formula's
 *      verdict disagrees with the LLM's independent call (in the direction
 *      the asymmetric merge policy does NOT resolve automatically — i.e. the
 *      formula was satisfied but the LLM failed the behavior; see
 *      verdict-merge.ts's documented policy) is real evidence the compiled
 *      formula no longer matches the plain-language claim. Sticky flag,
 *      surfaced for recompilation; auto-demotion back to draft is a separate,
 *      explicitly opt-in policy (see applyRecompileDemotions).
 *
 * VACUITY is tracked here too (as a tally) but DETECTED in ./vacuity.ts — a
 * vacuously-satisfied verdict is recorded as neither agreement nor
 * disagreement (see the "meaningful pass" note on recordFormulaVerdict):
 * counting a hollow pass as agreement evidence would let a formula whose
 * antecedent never fires "promote" purely on inactivity.
 *
 * STORAGE: `.specify/formula-stats.json`, sibling to
 * `.specify/confidence.json` (src/agent/confidence-store.ts), atomic
 * tmp-write + rename (pattern of src/daemon/inbox-state.ts's saveMessage).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { specRootDir } from '../spec/paths.js';
import type { Verdict } from './evaluate.js';
import { setStatus, type FormulasFile } from '../spec/formulas.js';

/** Consecutive shadow-mode agreements required before a promotion suggestion fires. */
export const PROMOTION_STREAK = 5;

/** Sliding window (most recent N verdicts) drift detection looks at. */
export const DRIFT_WINDOW = 8;

/** Fraction of the window that must be inconclusive/unevaluable to flag drift. */
export const DRIFT_THRESHOLD = 0.5;

export interface FormulaStatsRow {
  formulaId: string;
  runsSeen: number;
  satisfied: number;
  violated: number;
  inconclusive: number;
  unevaluable: number;
  /** Subset of `satisfied` where the verdict rested on a never-fired antecedent (vacuity.ts). */
  vacuousSatisfied: number;
  /** Shadow-mode (draft) agreements with the LLM's independent verdict. */
  agreements: number;
  /** Shadow-mode (draft) disagreements, OR an approved formula's unresolved disagreement. */
  disagreements: number;
  /** Current run of consecutive agreements; reset to 0 on any disagreement. */
  consecutiveAgreements: number;
  /** True once this formula has produced at least one determinate (satisfied/violated) verdict. */
  groundedSeen: boolean;
  /** Ring buffer of the last DRIFT_WINDOW verdicts, oldest first. */
  recentVerdicts: Verdict[];
  /** Sticky once set: a previously-grounded formula started flagging mostly inconclusive/unevaluable. */
  driftFlagged: boolean;
  driftDetectedAt?: string;
  /** Sticky once set: an approved formula disagreed with the LLM's independent verdict. */
  recompileFlagged: boolean;
  recompileFlaggedAt?: string;
  lastVerdict: Verdict;
  lastRunAt: string;
}

export interface FormulaStatsFile {
  version: 1;
  rows: Record<string, FormulaStatsRow>;
}

export function emptyFormulaStatsFile(): FormulaStatsFile {
  return { version: 1, rows: {} };
}

export function defaultFormulaStatsPath(specPath: string): string {
  return path.join(specRootDir(specPath), '.specify', 'formula-stats.json');
}

export function loadFormulaStats(filePath: string): FormulaStatsFile {
  if (!fs.existsSync(filePath)) return emptyFormulaStatsFile();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && raw.version === 1 && raw.rows && typeof raw.rows === 'object') {
      return raw as FormulaStatsFile;
    }
  } catch {
    // Corrupt file — telemetry is best-effort, start fresh rather than crash.
  }
  return emptyFormulaStatsFile();
}

/** Atomic write: tmp file + rename, matching src/daemon/inbox-state.ts's saveMessage. */
export function saveFormulaStats(filePath: string, file: FormulaStatsFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify(file, null, 2) + '\n';
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function defaultRow(formulaId: string): FormulaStatsRow {
  return {
    formulaId,
    runsSeen: 0,
    satisfied: 0,
    violated: 0,
    inconclusive: 0,
    unevaluable: 0,
    vacuousSatisfied: 0,
    agreements: 0,
    disagreements: 0,
    consecutiveAgreements: 0,
    groundedSeen: false,
    recentVerdicts: [],
    driftFlagged: false,
    recompileFlagged: false,
    lastVerdict: 'inconclusive',
    lastRunAt: '',
  };
}

export interface RecordVerdictInput {
  formulaId: string;
  formulaStatus: 'draft' | 'approved';
  verdict: Verdict;
  /** The LLM's OWN status for this behavior, independent of any monitor override. */
  llmStatus: 'passed' | 'failed' | 'skipped';
  /** True iff vacuity.ts determined this 'satisfied' verdict rests on a never-fired antecedent. */
  vacuous: boolean;
  /** ISO timestamp; defaults to now. Threaded explicitly so tests are deterministic. */
  timestamp?: string;
}

export interface RecordVerdictResult {
  file: FormulaStatsFile;
  row: FormulaStatsRow;
  /** True iff the agreement streak crossed PROMOTION_STREAK on THIS run (not merely "is currently at/above it"). */
  promotionJustSuggested: boolean;
  /** True iff drift was newly flagged on THIS run. */
  driftJustDetected: boolean;
  /** True iff the recompile flag was newly set on THIS run. */
  recompileJustFlagged: boolean;
}

/**
 * Fold one formula verdict into the stats file. Pure — returns a new file;
 * the input is never mutated. Callers own persistence (loadFormulaStats /
 * saveFormulaStats) so this stays trivially unit-testable.
 */
export function recordFormulaVerdict(file: FormulaStatsFile, input: RecordVerdictInput): RecordVerdictResult {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const prev = file.rows[input.formulaId] ?? defaultRow(input.formulaId);
  const row: FormulaStatsRow = { ...prev, recentVerdicts: [...prev.recentVerdicts] };

  row.runsSeen += 1;
  row.lastVerdict = input.verdict;
  row.lastRunAt = timestamp;

  switch (input.verdict) {
    case 'satisfied':
      row.satisfied += 1;
      if (input.vacuous) row.vacuousSatisfied += 1;
      break;
    case 'violated':
      row.violated += 1;
      break;
    case 'inconclusive':
      row.inconclusive += 1;
      break;
    case 'unevaluable':
      row.unevaluable += 1;
      break;
  }

  if (input.verdict === 'satisfied' || input.verdict === 'violated') {
    row.groundedSeen = true;
  }

  // Agreement: neutral (neither agree nor disagree) for inconclusive,
  // unevaluable, vacuous-satisfied passes, AND LLM-skipped behaviors — none
  // of those are evidence the formula's determination tracks (or fails to
  // track) the LLM's independent judgement. Skipped in particular: the LLM
  // never rendered a verdict to agree or disagree with, so the streak
  // neither advances nor resets.
  let agree: boolean | undefined;
  if (input.verdict === 'inconclusive' || input.verdict === 'unevaluable') {
    agree = undefined;
  } else if (input.llmStatus === 'skipped') {
    agree = undefined;
  } else if (input.verdict === 'satisfied' && input.vacuous) {
    agree = undefined;
  } else if (input.verdict === 'satisfied') {
    agree = input.llmStatus === 'passed';
  } else {
    // violated
    agree = input.llmStatus === 'failed';
  }

  const streakBefore = row.consecutiveAgreements;
  if (agree === true) {
    row.agreements += 1;
    row.consecutiveAgreements += 1;
  } else if (agree === false) {
    row.disagreements += 1;
    row.consecutiveAgreements = 0;
  }
  const promotionJustSuggested =
    input.formulaStatus === 'draft' &&
    streakBefore < PROMOTION_STREAK &&
    row.consecutiveAgreements >= PROMOTION_STREAK;

  // Drift: sliding window over the most recent verdicts.
  row.recentVerdicts.push(input.verdict);
  if (row.recentVerdicts.length > DRIFT_WINDOW) {
    row.recentVerdicts.splice(0, row.recentVerdicts.length - DRIFT_WINDOW);
  }
  let driftJustDetected = false;
  if (!row.driftFlagged && row.groundedSeen && row.recentVerdicts.length >= DRIFT_WINDOW) {
    const murky = row.recentVerdicts.filter((v) => v === 'inconclusive' || v === 'unevaluable').length;
    if (murky / row.recentVerdicts.length >= DRIFT_THRESHOLD) {
      row.driftFlagged = true;
      row.driftDetectedAt = timestamp;
      driftJustDetected = true;
    }
  }

  // Recompile flag: ONLY the satisfied-but-LLM-failed direction. That is
  // the one disagreement the asymmetric merge policy leaves unresolved (the
  // formula quietly missed a real failure — a recompile candidate). The
  // opposite direction — violated while the LLM passed — is already acted
  // on by the merge (monitor wins, behavior forced to failed) and is the
  // formula WORKING, so it must never flag recompile. Vacuous passes are
  // excluded too: a never-exercised implication trivially "holding" while
  // the LLM fails says nothing about the compiled consequence.
  let recompileJustFlagged = false;
  if (
    input.formulaStatus === 'approved' &&
    input.verdict === 'satisfied' &&
    !input.vacuous &&
    input.llmStatus === 'failed' &&
    !row.recompileFlagged
  ) {
    row.recompileFlagged = true;
    row.recompileFlaggedAt = timestamp;
    recompileJustFlagged = true;
  }

  return {
    file: { ...file, rows: { ...file.rows, [input.formulaId]: row } },
    row,
    promotionJustSuggested,
    driftJustDetected,
    recompileJustFlagged,
  };
}

/** True iff the row currently sits at/above the promotion streak (regardless of when it crossed). */
export function isPromotionCandidate(row: FormulaStatsRow): boolean {
  return row.consecutiveAgreements >= PROMOTION_STREAK;
}

/**
 * Optional, explicitly opt-in policy: demote every 'approved' formula whose
 * stats row has recompileFlagged set back to 'draft' (shadow mode), so a
 * formula that has drifted out of agreement with the LLM stops gating
 * verdicts until it's recompiled and re-reviewed. NOT applied automatically
 * by recordFormulaVerdict/mergeMonitorVerdicts — callers gate this behind
 * their own feature flag (see monitorAutoDemoteEnabled in
 * src/agent/feature-flags.ts) and call it explicitly, since silently
 * un-gating a previously-trusted formula is a policy decision, not a pure
 * telemetry side effect.
 */
export function applyRecompileDemotions(
  formulasFile: FormulasFile,
  statsFile: FormulaStatsFile,
): { file: FormulasFile; demoted: string[] } {
  let file = formulasFile;
  const demoted: string[] = [];
  for (const entry of formulasFile.formulas) {
    if (entry.status !== 'approved') continue;
    if (statsFile.rows[entry.id]?.recompileFlagged) {
      file = setStatus(file, entry.id, 'draft');
      demoted.push(entry.id);
    }
  }
  return { file, demoted };
}
