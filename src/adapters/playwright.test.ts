import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPlaywright } from './playwright.js';

function fixture(
  report: unknown,
  exitCode = 0,
  cliSource?: string,
): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-playwright-adapter-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const pkg = path.join(dir, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"main":"cli.js"}');
  fs.writeFileSync(
    path.join(pkg, 'cli.js'),
    cliSource ??
      `const fs = require('node:fs'); console.log(fs.readFileSync(__dirname + '/report.json', 'utf8')); process.exitCode = ${exitCode};`,
  );
  fs.writeFileSync(
    path.join(pkg, 'report.json'),
    typeof report === 'string' ? report : JSON.stringify(report),
  );
  fs.writeFileSync(path.join(dir, 'checkout.spec.js'), '');
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('runs caller-installed Playwright CLI directly and preserves skipped status', async () => {
  const f = fixture({
    suites: [
      {
        specs: [
          {
            title: 'cart/add: add item works',
            ok: true,
            tests: [{ results: [{ status: 'skipped' }] }],
          },
        ],
      },
    ],
  });
  try {
    const result = await runPlaywright({ cwd: f.dir });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.tests[0].behaviorId, 'cart/add');
      assert.equal(result.tests[0].status, 'skipped');
    }
  } finally {
    f.cleanup();
  }
});

test('nonzero runner exit without a test failure is an error, not a pass', async () => {
  const f = fixture(
    {
      suites: [
        {
          specs: [
            {
              title: 'cart/add: add item works',
              ok: true,
              tests: [{ results: [{ status: 'passed' }] }],
            },
          ],
        },
      ],
    },
    2,
  );
  try {
    const result = await runPlaywright({ cwd: f.dir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'error');
  } finally {
    f.cleanup();
  }
});

test('a timed-out attempt remains failed even if a retry passed', async () => {
  const f = fixture({
    suites: [
      {
        specs: [
          {
            title: 'cart/add: add item works',
            ok: true,
            tests: [{ results: [{ status: 'timedOut' }, { status: 'passed' }] }],
          },
        ],
      },
    ],
  });
  try {
    const result = await runPlaywright({ cwd: f.dir });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.tests[0].status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('malformed JSON reporter output is a runner error', async () => {
  const f = fixture('{ malformed');
  try {
    const result = await runPlaywright({ cwd: f.dir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'error');
  } finally {
    f.cleanup();
  }
});

test('runner output is capped and overflow terminates the process', async () => {
  const f = fixture(
    {},
    0,
    "process.stdout.write('x'.repeat(11 * 1024 * 1024)); setInterval(() => {}, 1000);",
  );
  try {
    const result = await runPlaywright({ cwd: f.dir, timeoutMs: 5000 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'error');
      assert.match(result.message, /output exceeded/);
    }
  } finally {
    f.cleanup();
  }
});

test('timeout kills the POSIX process group including a spawned worker', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process groups are not available on Windows');
    return;
  }
  const pidFile = path.join(os.tmpdir(), `specify-scripted-worker-${process.pid}.pid`);
  fs.rmSync(pidFile, { force: true });
  const f = fixture(
    {},
    0,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));`,
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  try {
    const result = await runPlaywright({ cwd: f.dir, timeoutMs: 100 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timeout');
    const workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 1500;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(workerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'spawned worker should be killed with the runner process group');
  } finally {
    fs.rmSync(pidFile, { force: true });
    f.cleanup();
  }
});

test('reports no tests rather than treating an absent suite as successful', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-playwright-empty-'));
  try {
    assert.deepEqual(await runPlaywright({ cwd: dir }), { ok: false, reason: 'no_tests' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('executes a real tiny caller-owned Playwright CLI project', async (t) => {
  const playwrightPackage = path.resolve(
    process.env.SPECIFY_TEST_PLAYWRIGHT_PATH ?? 'node_modules/playwright',
  );
  if (!fs.existsSync(path.join(playwrightPackage, 'cli.js'))) {
    t.skip('Playwright CLI is not installed in the test environment');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-playwright-real-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const modules = path.join(dir, 'node_modules');
    fs.mkdirSync(modules);
    fs.symlinkSync(playwrightPackage, path.join(modules, 'playwright'), 'dir');
    fs.writeFileSync(
      path.join(dir, 'contract.spec.js'),
      [
        "const { test, expect } = require('playwright/test');",
        "test('cart/add: tiny caller-owned invariant', () => expect(2 + 2).toBe(4));",
        '',
      ].join('\n'),
    );
    const result = await runPlaywright({ cwd: dir, timeoutMs: 30_000 });
    assert.equal(
      result.ok,
      true,
      result.ok ? '' : 'message' in result ? result.message : result.reason,
    );
    if (result.ok) {
      assert.deepEqual(
        result.tests.map((entry) => [entry.behaviorId, entry.status]),
        [['cart/add', 'passed']],
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
