/**
 * src/agent/scripted-runner.ts — Deterministic, agent-free verify tier.
 *
 * SP-y2b's test-runner.ts runs generated Playwright tests to *confirm*
 * individual agent-reported failures. This module is the other half:
 * running the FULL generated suite with no LLM in the loop at all, mapping
 * titles back to behavior ids via the same `<area-id>/<behavior-id>:`
 * contract, and producing BehaviorResult[] that slot directly into a
 * verify-result.json report.
 *
 * Two consumers (src/cli/index.ts verify branch):
 *  - `--mode scripted`: this IS the verification, no agent involved.
 *  - `--cross-check`: this runs alongside a normal agent verify as an
 *    independent differential check, never flipping agent verdicts.
 *  - `--mode auto`: scripted pass first; only failed/untested behaviors
 *    escalate to the agent tier.
 */

import { ExitCode, type ExitCodeValue } from '../cli/exit-codes.js';
import type { BehaviorResult, Spec } from '../spec/types.js';
import { runPlaywrightTests, type FlatTestResult, type RunPlaywrightTestsOptions } from './test-runner.js';

/** `BehaviorResult.method` value used for every result this module produces. */
export const SCRIPTED_METHOD = 'scripted-replay';

export type ScriptedSuiteResult =
  | { ok: true; tests: FlatTestResult[] }
  | { ok: false; reason: 'no_tests' }
  | { ok: false; reason: 'runner_error'; message: string };

/**
 * Runs the FULL generated suite (no -g filter) in `opts.cwd` and returns the
 * flattened test list, or a typed failure. Never throws — mirrors
 * `runPlaywrightTests`'s never-throw contract so callers never fabricate
 * results out of a runner crash.
 */
export async function runScriptedSuite(
  opts: Omit<RunPlaywrightTestsOptions, 'grep'>,
): Promise<ScriptedSuiteResult> {
  const result = await runPlaywrightTests(opts);
  if (result.ok) return { ok: true, tests: result.tests };
  if (result.reason === 'no_tests') return { ok: false, reason: 'no_tests' };
  return { ok: false, reason: 'runner_error', message: result.message ?? result.reason };
}

/**
 * Runs a GREP-SCOPED subset of the generated suite (SP-9kp) — the
 * counterpart to `runScriptedSuite`'s full-suite run. Used by `--mode auto`'s
 * confidence-driven routing to execute only the behaviors the technique
 * selector routed to 'scripted', instead of paying for the whole suite.
 * Never throws — same never-throw contract as `runScriptedSuite`.
 */
export async function runScopedScriptedSuite(
  grep: string,
  opts: Omit<RunPlaywrightTestsOptions, 'grep'>,
): Promise<ScriptedSuiteResult> {
  const result = await runPlaywrightTests({ ...opts, grep });
  if (result.ok) return { ok: true, tests: result.tests };
  if (result.reason === 'no_tests') return { ok: false, reason: 'no_tests' };
  return { ok: false, reason: 'runner_error', message: result.message ?? result.reason };
}

/** Strips the "<area>/<behavior>: " prefix off a generated test title, leaving the description. */
function stripBehaviorPrefix(title: string): string {
  return title.replace(/^[^\s/]+\/[^\s:]+:\s*/, '').trim();
}

/**
 * Pure: converts flattened Playwright test results into one BehaviorResult
 * per matched behavior id. Tests whose title doesn't match the
 * "<area>/<behavior>: description" contract are dropped — they can't be
 * attributed to a spec behavior.
 *
 * When multiple tests map to the same behavior id (e.g. re-run across
 * browsers/projects), a failure anywhere wins over a pass — conservative,
 * matching the spirit of `decideConfirmation` in test-runner.ts.
 */
export function testsToBehaviorResults(tests: FlatTestResult[]): BehaviorResult[] {
  const byId = new Map<string, FlatTestResult[]>();
  for (const t of tests) {
    if (!t.behaviorId) continue;
    const arr = byId.get(t.behaviorId) ?? [];
    arr.push(t);
    byId.set(t.behaviorId, arr);
  }

  const out: BehaviorResult[] = [];
  for (const [id, group] of byId) {
    const failed = group.find((t) => t.status === 'failed');
    const rep = failed ?? group[0];
    out.push({
      id,
      description: stripBehaviorPrefix(rep.title),
      status: rep.status,
      method: SCRIPTED_METHOD,
      evidence: [
        {
          type: 'text',
          label: 'scripted-replay',
          content:
            rep.status === 'failed'
              ? `generated test failed: ${rep.error ?? '(no error message captured)'}`
              : 'generated test passed',
        },
      ],
    });
  }
  return out;
}

/**
 * Behaviors declared in `spec` with no matching entry in `matchedIds` — i.e.
 * no generated test covers them at all. BehaviorResult.status has no
 * "untested" value, so these are reported as `skipped` with a rationale
 * that says so explicitly; callers that need to distinguish "untested" from
 * an agent-produced skip should check `rationale`.
 */
export function untestedBehaviorResults(spec: Spec, matchedIds: ReadonlySet<string>): BehaviorResult[] {
  const out: BehaviorResult[] = [];
  for (const area of spec.areas ?? []) {
    for (const behavior of area.behaviors ?? []) {
      const id = `${area.id}/${behavior.id}`;
      if (matchedIds.has(id)) continue;
      out.push({
        id,
        description: behavior.description,
        status: 'skipped',
        method: SCRIPTED_METHOD,
        rationale: 'untested: no generated test matched this behavior id',
      });
    }
  }
  return out;
}

export type ScriptedVerifyResult =
  | { ok: true; results: BehaviorResult[]; matched: number }
  | { ok: false; reason: 'no_tests' }
  | { ok: false; reason: 'runner_error'; message: string };

/**
 * Runs the full generated suite for `spec` in `outputDir` and returns a
 * complete BehaviorResult[] covering every behavior in the spec: matched
 * tests contribute passed/failed results, everything else is `skipped`
 * (untested). `matched` is the count of behaviors an actual test covered —
 * 0 means nothing in the spec has a generated test at all.
 */
export async function runScriptedForSpec(
  spec: Spec,
  outputDir: string,
  opts?: { timeoutMs?: number },
): Promise<ScriptedVerifyResult> {
  const suite = await runScriptedSuite({ cwd: outputDir, timeoutMs: opts?.timeoutMs });
  if (!suite.ok) return suite;

  const testResults = testsToBehaviorResults(suite.tests);
  const matchedIds = new Set(testResults.map((r) => r.id));
  const untested = untestedBehaviorResults(spec, matchedIds);
  return { ok: true, results: [...testResults, ...untested], matched: matchedIds.size };
}

/**
 * Splits scripted results for `--mode auto`: behaviors whose scripted test
 * passed stay as-is (no agent attention needed); everything else — failed
 * or untested — escalates to the agent tier. A scripted failure is never
 * terminal in auto mode: stale tests after app changes are expected, so the
 * agent gets a chance to re-verify and regenerate.
 */
export function partitionScriptedResults(results: BehaviorResult[]): {
  passed: BehaviorResult[];
  escalate: BehaviorResult[];
} {
  const passed = results.filter((r) => r.status === 'passed');
  const escalate = results.filter((r) => r.status !== 'passed');
  return { passed, escalate };
}

/**
 * Exit code for `--mode scripted`: ALL_UNTESTED when nothing in the spec
 * has a generated test at all (`matched === 0`), otherwise the normal
 * pass/fail mapping (a failure anywhere → ASSERTION_FAILURE, else SUCCESS).
 */
export function scriptedModeExitCode(matched: number, results: BehaviorResult[]): ExitCodeValue {
  if (matched === 0) return ExitCode.ALL_UNTESTED;
  return results.some((r) => r.status === 'failed') ? ExitCode.ASSERTION_FAILURE : ExitCode.SUCCESS;
}

export interface CrossCheckEntry {
  id: string;
  agentStatus: BehaviorResult['status'];
  testStatus: 'passed' | 'failed';
  agreement: boolean;
}

/**
 * Diffs agent verdicts against independently-executed scripted results.
 * Report-only: this never changes `agentResults`, statuses, or exit codes —
 * it's purely a differential signal for `cross_check` in verify-result.json
 * and for `crosscheck:*` events.
 *
 * Only behaviors with BOTH an agent verdict AND a matched scripted test
 * (passed or failed — untested/skipped scripted entries carry no test
 * outcome to diff against) produce an entry.
 */
export function diffCrossCheck(agentResults: BehaviorResult[], scriptedResults: BehaviorResult[]): CrossCheckEntry[] {
  const scriptedById = new Map(scriptedResults.map((r) => [r.id, r]));
  const out: CrossCheckEntry[] = [];
  for (const agent of agentResults) {
    const scripted = scriptedById.get(agent.id);
    if (!scripted || (scripted.status !== 'passed' && scripted.status !== 'failed')) continue;
    const testStatus = scripted.status;
    out.push({
      id: agent.id,
      agentStatus: agent.status,
      testStatus,
      agreement: agent.status === testStatus,
    });
  }
  return out;
}
