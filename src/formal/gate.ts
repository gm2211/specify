import fs from 'node:fs';
import path from 'node:path';
import { runReferences, type CheckFormalOptions } from './check.js';
import { loadConfig, type Policy } from './config.js';
import { changedFiles, fileAtRef } from './git.js';
import {
  buildLock,
  coveredByChanges,
  diffLocks,
  LOCK_FILE,
  parseLock,
  serializeLock,
  type Weakening,
} from './lock.js';
import { listActiveChanges, scanOpenSpec, type FormalReference } from './openspec.js';
import { evaluatePolicy, type PolicyFinding } from './policy.js';
import type { FormalCheckResult, FormalWaiver } from './types.js';
import { checkVerifyLinks, loadTestReports, type VerifyResult } from './verify.js';

export interface GateOptions extends Omit<CheckFormalOptions, 'change'> {
  /** Overrides `formal/specify.json`. */
  policy?: Policy;
  /** Run only checks whose spec or model file differs from the base ref. */
  changed?: boolean;
  /** Git ref the drift lock and `changed` compare against (default HEAD). */
  base?: string;
  /** Do not require test results for `Verify:` lines (hooks run before the tests do). */
  skipVerify?: boolean;
  /** Test report files; overrides `testReports` in the config. */
  testReports?: string[];
  /** A missing tool does not fail the gate (for local hooks; CI installs the tools). */
  tolerateUnavailable?: boolean;
}

export type LockStatus = 'ok' | 'missing' | 'stale' | 'invalid';

export interface MatrixRow {
  requirementId: string;
  model: string;
  before: string;
  test: string;
}

export interface GateSummary {
  valid: boolean;
  scope: 'formal-models-only';
  root: string;
  policy: Policy;
  results: FormalCheckResult[];
  /** Checks left out by `--changed` because neither their spec nor their model changed. */
  skippedChecks: number;
  waivers: FormalWaiver[];
  findings: PolicyFinding[];
  verify: VerifyResult[];
  lock: { status: LockStatus; weakenings: Weakening[] };
  matrix: MatrixRow[];
  /** Why the gate is closed; empty when `valid`. */
  failures: string[];
  /** Reported but not failing (the `warn` policy, tolerated missing tools). */
  warnings: string[];
  totals: { requirements: number; checks: number; ok: number; notOk: number };
}

const FROM_CHANGE = 'openspec/changes/';

export async function runGate(options: GateOptions): Promise<GateSummary> {
  const root = path.resolve(options.root);
  const config = loadConfig(root);
  const policy = options.policy ?? config.policy;
  const strict = policy === 'strict';
  const scan = scanOpenSpec(root);
  const changed = changedFiles(root, options.base);

  // Main specs, then the delta specs of every active change.
  const pending: Array<{ ref: FormalReference; change?: string }> = scan.references.map((ref) => ({
    ref,
  }));
  const findings = evaluatePolicy(scan);
  const verifyLinks = [...scan.verifies];
  for (const change of listActiveChanges(root)) {
    const overlay = scanOpenSpec(root, change);
    const fromChange = <T extends { source: { file: string } }>(items: T[]): T[] =>
      items.filter((item) => item.source.file.startsWith(FROM_CHANGE));
    pending.push(...fromChange(overlay.references).map((ref) => ({ ref, change })));
    verifyLinks.push(...fromChange(overlay.verifies));
    const known = new Set(findings.map((finding) => `${finding.rule}\n${finding.requirementId}`));
    for (const finding of evaluatePolicy(overlay)) {
      if (!known.has(`${finding.rule}\n${finding.requirementId}`)) {
        findings.push({ ...finding, change });
      }
    }
  }

  const selected =
    options.changed && changed
      ? pending.filter(
          ({ ref }) => changed.has(ref.source.file) || (ref.check && changed.has(ref.check.file)),
        )
      : pending;
  const byTool = selected.filter(
    ({ ref }) => !options.tool || !ref.check || ref.check.tool === options.tool,
  );
  const results: FormalCheckResult[] = [];
  for (const { ref, change } of byTool) {
    const [result] = await runReferences([ref], options);
    results.push(change ? { ...result, change } : result);
  }

  const reports = options.testReports ?? config.testReports;
  const verify = checkVerifyLinks(verifyLinks, loadTestReports(root, reports));

  // Drift lock: the committed lock must match the specs, and nothing may be weaker than at base.
  const current = buildLock(root, scan);
  const lockPath = path.join(root, LOCK_FILE);
  let status: LockStatus = 'ok';
  if (!fs.existsSync(lockPath)) {
    status = Object.keys(current.requirements).length ? 'missing' : 'ok';
  } else if (fs.readFileSync(lockPath, 'utf8') !== serializeLock(current)) {
    status = 'stale';
  }
  let weakenings: Weakening[] = [];
  const baseText = changed ? fileAtRef(root, options.base ?? 'HEAD', LOCK_FILE) : undefined;
  if (baseText !== undefined) {
    try {
      weakenings = diffLocks(parseLock(baseText), current, coveredByChanges(root, changed));
    } catch {
      status = 'invalid';
    }
  }

  const failures: string[] = [];
  const warnings: string[] = [];
  const policyProblem = (message: string): void => {
    (strict ? failures : warnings).push(message);
  };
  for (const result of results) {
    if (result.ok) continue;
    const label = `${result.requirementId}: ${result.outcome.message ?? result.outcome.status}`;
    if (options.tolerateUnavailable && result.outcome.status === 'unavailable') {
      warnings.push(`${label} (not run here; CI runs it)`);
    } else failures.push(label);
  }
  for (const finding of findings) {
    const scope = finding.change ? ` (change ${finding.change})` : '';
    policyProblem(`${finding.requirementId}${scope}: ${finding.message}`);
  }
  for (const entry of verify) {
    if (entry.ok) continue;
    const label = `${entry.requirementId}: ${entry.message ?? entry.status}`;
    if (entry.status === 'invalid') failures.push(label);
    else if (!options.skipVerify) policyProblem(label);
  }
  if (status === 'missing') {
    policyProblem(`${LOCK_FILE} is missing; run "specify lock" and commit it`);
  } else if (status === 'stale') {
    policyProblem(`${LOCK_FILE} does not match the specs; run "specify lock" and commit it`);
  } else if (status === 'invalid') {
    policyProblem(`${LOCK_FILE} at ${options.base ?? 'HEAD'} is not a readable lock`);
  }
  for (const weakening of weakenings) {
    if (weakening.covered) continue;
    policyProblem(
      `${weakening.requirementId}: ${weakening.kind} without an OpenSpec change proposal (${weakening.detail})`,
    );
  }
  const requirements = new Set(scan.requirementIds).size;
  if (
    requirements &&
    !results.length &&
    !scan.waivers.length &&
    !(pending.length - byTool.length)
  ) {
    failures.push('No Formal lines or waivers found under any OpenSpec requirement');
  }

  const ok = results.filter((result) => result.ok).length;
  return {
    valid: failures.length === 0,
    scope: 'formal-models-only',
    root,
    policy,
    results,
    skippedChecks: pending.length - selected.length,
    waivers: scan.waivers,
    findings,
    verify,
    lock: { status, weakenings },
    matrix: buildMatrix(scan.requirementIds, results, scan.waivers, verify),
    failures,
    warnings,
    totals: { requirements, checks: results.length, ok, notOk: results.length - ok },
  };
}

function buildMatrix(
  requirementIds: string[],
  results: FormalCheckResult[],
  waivers: FormalWaiver[],
  verify: VerifyResult[],
): MatrixRow[] {
  const mark = (ok: boolean): string => (ok ? '✓' : '✗');
  return [...new Set(requirementIds)].map((requirementId) => {
    const own = results.filter(
      (result) => result.requirementId === requirementId && !result.change,
    );
    const holds = own.filter((result) => result.check?.expect !== 'fails');
    const before = own.filter((result) => result.check?.expect === 'fails');
    const tests = verify.filter((entry) => entry.requirementId === requirementId);
    const summarize = (items: FormalCheckResult[], empty: string): string =>
      items.length
        ? `${items.filter((item) => item.ok).length}/${items.length} ${mark(items.every((item) => item.ok))}`
        : empty;
    const waiver = waivers.find((entry) => entry.requirementId === requirementId);
    return {
      requirementId,
      model: summarize(holds, waiver ? 'waived' : '-'),
      before: summarize(before, '-'),
      test: tests.length
        ? `${tests.filter((entry) => entry.ok).length}/${tests.length} ${mark(tests.every((entry) => entry.ok))}`
        : '-',
    };
  });
}

/** Write `formal/specify.lock` from the current specs. */
export function writeLock(root: string): { file: string; requirements: number; changed: boolean } {
  const resolved = path.resolve(root);
  const text = serializeLock(buildLock(resolved, scanOpenSpec(resolved)));
  const file = path.join(resolved, LOCK_FILE);
  const changed = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text;
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { file, requirements: Object.keys(parseLock(text).requirements).length, changed };
}
