/**
 * src/agent/test-runner.ts — Execute generated Playwright specs and parse
 * their JSON reporter output.
 *
 * Born out of SP-y2b: the verify agent already writes a Playwright test for
 * every reported behavior (passed AND failed — see the E2E Test Generation
 * section of `getVerifyPrompt`), but nothing ever ran those tests. Running
 * the failing ones post-run turns "the LLM says this failed" into "the LLM
 * says this failed, and a deterministic, independently-executed test agrees."
 *
 * This module is deliberately general — it can run the full suite or a
 * `-g` filtered subset — because SP-bjr (the scripted verification tier)
 * reuses it to run whole suites without any LLM in the loop.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A single test result, flattened out of Playwright's nested json reporter suites. */
export interface FlatTestResult {
  /** Full test() title, e.g. "area-id/behavior-id: does the thing". */
  title: string;
  /** "<area-id>/<behavior-id>" parsed off the front of the title, if it matches the contract. */
  behaviorId?: string;
  status: 'passed' | 'failed';
  /** First error message, if the test failed. */
  error?: string;
}

export type RunPlaywrightTestsResult =
  | { ok: true; tests: FlatTestResult[]; raw: string }
  | { ok: false; reason: 'no_tests' }
  | { ok: false; reason: 'playwright_unresolvable'; message: string }
  | { ok: false; reason: 'timeout'; message: string }
  | { ok: false; reason: 'error'; message: string };

export interface RunPlaywrightTestsOptions {
  /** Directory containing playwright.config.ts and the generated spec files. */
  cwd: string;
  /** Optional -g / --grep filter, e.g. a behavior id. Matched as a regex against full test titles. */
  grep?: string;
  /** Max time to allow the whole `npx playwright test` invocation, in ms. Default 60s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Escape a string for literal use inside a regex (e.g. as a -g grep pattern). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extracts "<area-id>/<behavior-id>" off the front of a test title formatted per the E2E test-title contract. */
export function extractBehaviorId(title: string): string | undefined {
  const m = /^([^\s/]+\/[^\s:]+):/.exec(title.trim());
  return m ? m[1] : undefined;
}

/** True if `dir` contains at least one generated Playwright spec file. */
function hasSpecFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js'));
  } catch {
    return false;
  }
}

interface RawPlaywrightResult {
  status?: string;
  error?: { message?: string };
}
interface RawPlaywrightTest {
  status?: string;
  results?: RawPlaywrightResult[];
}
interface RawPlaywrightSpec {
  title: string;
  ok?: boolean;
  tests?: RawPlaywrightTest[];
}
interface RawPlaywrightSuite {
  title?: string;
  suites?: RawPlaywrightSuite[];
  specs?: RawPlaywrightSpec[];
}
interface RawPlaywrightReport {
  suites?: RawPlaywrightSuite[];
}

/** Flattens Playwright's nested suites/specs tree (json reporter) into a flat list of test results. */
export function flattenReporterSpecs(report: RawPlaywrightReport): FlatTestResult[] {
  const out: FlatTestResult[] = [];

  const visitSpec = (spec: RawPlaywrightSpec) => {
    const passed = spec.ok !== false;
    let error: string | undefined;
    if (!passed) {
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          if (r.error?.message) {
            error = r.error.message;
            break;
          }
        }
        if (error) break;
      }
    }
    out.push({
      title: spec.title,
      behaviorId: extractBehaviorId(spec.title),
      status: passed ? 'passed' : 'failed',
      ...(error ? { error } : {}),
    });
  };

  const visitSuite = (suite: RawPlaywrightSuite) => {
    for (const spec of suite.specs ?? []) visitSpec(spec);
    for (const sub of suite.suites ?? []) visitSuite(sub);
  };

  for (const suite of report.suites ?? []) visitSuite(suite);
  return out;
}

const UNRESOLVABLE_PATTERNS = [
  /cannot find (package|module) ['"]?@playwright\/test['"]?/i,
  /cannot find module ['"]?playwright['"]?/i,
  /playwright: command not found/i,
  /ERR_MODULE_NOT_FOUND/i,
];

/**
 * Runs `npx playwright test [--grep <grep>] --reporter=json` in `cwd` and
 * returns the flattened, parsed results.
 *
 * Never throws — every failure mode (no tests generated, @playwright/test not
 * installed in the output dir, timeout, unparsable output) is returned as a
 * tagged result so callers can record "unconfirmable" instead of crashing.
 */
export async function runPlaywrightTests(
  opts: RunPlaywrightTestsOptions,
): Promise<RunPlaywrightTestsResult> {
  const { cwd, grep, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  if (!hasSpecFiles(cwd)) {
    return { ok: false, reason: 'no_tests' };
  }

  const args = ['playwright', 'test', '--reporter=json'];
  if (grep) args.push('--grep', grep);

  return new Promise<RunPlaywrightTestsResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const finish = (result: RunPlaywrightTestsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child?.kill('SIGKILL');
      } catch {
        // best-effort
      }
      finish({ ok: false, reason: 'timeout', message: `playwright test timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    try {
      child = spawn('npx', args, { cwd: path.resolve(cwd), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      finish({ ok: false, reason: 'error', message: err.message });
    });

    child.on('close', () => {
      const combined = `${stdout}\n${stderr}`;
      if (UNRESOLVABLE_PATTERNS.some((re) => re.test(combined))) {
        finish({ ok: false, reason: 'playwright_unresolvable', message: stderr.trim() || stdout.trim() });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as RawPlaywrightReport;
        finish({ ok: true, tests: flattenReporterSpecs(parsed), raw: stdout });
      } catch {
        finish({
          ok: false,
          reason: 'error',
          message: `could not parse playwright json reporter output: ${(stderr || stdout).slice(0, 500)}`,
        });
      }
    });
  });
}

export interface ConfirmBehaviorResult {
  /** Whether a matching generated test was found and actually re-ran the failure. */
  confirmed: boolean;
  /** The full title of the matched test, if any. */
  test?: string;
  /** Human-readable summary of what happened (surfaced verbatim in BehaviorResult.repro.output). */
  output: string;
}

/**
 * Runs the generated test(s) for a single failed behavior and decides
 * whether the failure is confirmed.
 *
 * "Confirmed" means: a generated test whose title starts with
 * "<behaviorId>:" was found and, when executed, itself reported status
 * "failed" — i.e. it independently reproduces the same failure the agent
 * reported. Anything else (no matching test, the test passes, a crash,
 * unresolvable @playwright/test, a timeout) is unconfirmed. This never
 * implies the reported behavior status should change — a generated test can
 * itself be wrong (bad selector, missing setup).
 */
/**
 * Pure decision function: given the flattened tests from a (possibly
 * grep-filtered) run and the behavior id we're confirming, decides
 * confirmed/unconfirmed. Split out from `confirmBehavior` so the
 * decision logic is unit-testable without spawning a real playwright
 * process.
 */
export function decideConfirmation(tests: FlatTestResult[], behaviorId: string): ConfirmBehaviorResult {
  const match = tests.find((t) => t.behaviorId === behaviorId) ?? tests[0];
  if (!match) {
    return { confirmed: false, output: 'unconfirmable: no generated test matched this behavior id' };
  }

  if (match.status === 'failed') {
    return {
      confirmed: true,
      test: match.title,
      output: `generated test failed as expected: ${match.error ?? '(no error message captured)'}`,
    };
  }

  return {
    confirmed: false,
    test: match.title,
    output: 'generated test passed, but the behavior was reported as failed — test does not reproduce the failure',
  };
}

export async function confirmBehavior(
  behaviorId: string,
  opts: Omit<RunPlaywrightTestsOptions, 'grep'>,
): Promise<ConfirmBehaviorResult | undefined> {
  const grep = escapeRegExp(`${behaviorId}:`);
  const result = await runPlaywrightTests({ ...opts, grep });

  if (!result.ok) {
    switch (result.reason) {
      case 'no_tests':
        // No generated tests at all for this run — nothing to confirm, and
        // not worth recording as "unconfirmable" noise.
        return undefined;
      case 'playwright_unresolvable':
        return { confirmed: false, output: `unconfirmable: @playwright/test not resolvable in output dir (${result.message})` };
      case 'timeout':
        return { confirmed: false, output: `unconfirmable: ${result.message}` };
      case 'error':
        return { confirmed: false, output: `unconfirmable: ${result.message}` };
    }
  }

  return decideConfirmation(result.tests, behaviorId);
}
