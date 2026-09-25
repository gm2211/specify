import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PlaywrightTestStatus = 'passed' | 'failed' | 'skipped';

export interface PlaywrightTestResult {
  title: string;
  behaviorId?: string;
  status: PlaywrightTestStatus;
  error?: string;
}

export type PlaywrightRunResult =
  | { ok: true; tests: PlaywrightTestResult[] }
  | { ok: false; reason: 'no_tests' }
  | { ok: false; reason: 'playwright_unresolvable'; message: string }
  | { ok: false; reason: 'timeout'; message: string }
  | { ok: false; reason: 'error'; message: string };

export interface RunPlaywrightOptions {
  cwd: string;
  timeoutMs?: number;
}

interface ReporterResult {
  status?: unknown;
  error?: { message?: unknown };
}
interface ReporterTest {
  status?: unknown;
  results?: ReporterResult[];
}
interface ReporterSpec {
  title?: unknown;
  ok?: unknown;
  tests?: ReporterTest[];
}
interface ReporterSuite {
  suites?: ReporterSuite[];
  specs?: ReporterSpec[];
}
interface ReporterReport {
  suites?: ReporterSuite[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const UNRESOLVABLE =
  /cannot find (package|module).*playwright|ERR_MODULE_NOT_FOUND|Cannot find package ['"]@playwright\/test/i;

export function extractBehaviorId(title: string): string | undefined {
  return /^([^\s/:]+\/[^\s:]+):/.exec(title.trim())?.[1];
}

function findTestFiles(dir: string): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && findTestFiles(path.join(dir, entry.name))) return true;
      if (entry.isFile() && /\.(spec|test)\.(?:[cm]?[jt]sx?)$/.test(entry.name)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function resolvePlaywrightCli(cwd: string): string {
  const requireFromCaller = createRequire(path.join(path.resolve(cwd), 'package.json'));
  for (const request of ['@playwright/test', 'playwright']) {
    try {
      const entry = requireFromCaller.resolve(request);
      const cli = path.join(path.dirname(entry), 'cli.js');
      if (fs.existsSync(cli)) return cli;
    } catch {
      // Try the caller's other supported package name.
    }
  }
  throw new Error(
    'Install @playwright/test or playwright in the caller project to run scripted verification.',
  );
}

function flatten(report: ReporterReport): PlaywrightTestResult[] {
  const tests: PlaywrightTestResult[] = [];
  const visit = (suite: ReporterSuite): void => {
    for (const spec of suite.specs ?? []) {
      if (typeof spec.title !== 'string') continue;
      const statuses = (spec.tests ?? [])
        .flatMap((test) => test.results ?? [])
        .map((r) => r.status);
      const errors = (spec.tests ?? [])
        .flatMap((test) => test.results ?? [])
        .map((r) => r.error?.message)
        .filter((v): v is string => typeof v === 'string');
      const status: PlaywrightTestStatus =
        spec.ok === false || statuses.includes('failed') || statuses.includes('timedOut')
          ? 'failed'
          : statuses.includes('skipped') || statuses.includes('interrupted')
            ? 'skipped'
            : statuses.includes('passed')
              ? 'passed'
              : 'skipped';
      tests.push({
        title: spec.title,
        ...(extractBehaviorId(spec.title) ? { behaviorId: extractBehaviorId(spec.title) } : {}),
        status,
        ...(errors[0] ? { error: errors[0] } : {}),
      });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return tests;
}

/** Run the Playwright CLI installed by the caller. This never invokes npx or downloads packages. */
export async function runPlaywright(opts: RunPlaywrightOptions): Promise<PlaywrightRunResult> {
  const cwd = path.resolve(opts.cwd);
  if (!findTestFiles(cwd)) return { ok: false, reason: 'no_tests' };

  let cli: string;
  try {
    cli = resolvePlaywrightCli(cwd);
  } catch (error) {
    return { ok: false, reason: 'playwright_unresolvable', message: String(error) };
  }

  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [cli, 'test', '--reporter=json'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({ ok: false, reason: 'error', message: String(error) });
      return;
    }
    const finish = (result: PlaywrightRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killRunner = () => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best effort: the process may already have exited.
        }
      }
    };
    const timer = setTimeout(() => {
      killRunner();
      finish({
        ok: false,
        reason: 'timeout',
        message: `Playwright test timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const onOutputLimit = () => {
      killRunner();
      finish({
        ok: false,
        reason: 'error',
        message: `Playwright output exceeded the ${MAX_OUTPUT_BYTES} byte limit`,
      });
    };
    child.stdout?.on('data', (data: Buffer) => {
      if (settled) return;
      stdoutBytes += data.length;
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        onOutputLimit();
        return;
      }
      stdout += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (settled) return;
      stderrBytes += data.length;
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        onOutputLimit();
        return;
      }
      stderr += data.toString();
    });
    child.on('error', (error) => finish({ ok: false, reason: 'error', message: error.message }));
    child.on('close', (code) => {
      if (UNRESOLVABLE.test(`${stderr}\n${stdout}`)) {
        finish({
          ok: false,
          reason: 'playwright_unresolvable',
          message: (stderr || stdout).trim(),
        });
        return;
      }
      try {
        const report = JSON.parse(stdout) as ReporterReport;
        const tests = flatten(report);
        if (tests.length === 0) finish({ ok: false, reason: 'no_tests' });
        else if (code !== 0 && !tests.some((test) => test.status === 'failed')) {
          finish({
            ok: false,
            reason: 'error',
            message: (stderr || `Playwright exited ${code} without test failure results`).trim(),
          });
        } else finish({ ok: true, tests });
      } catch {
        finish({
          ok: false,
          reason: 'error',
          message: `Could not parse Playwright JSON reporter output: ${(stderr || stdout).slice(0, 500)}`,
        });
      }
    });
  });
}
