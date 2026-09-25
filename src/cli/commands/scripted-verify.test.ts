import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { scriptedVerify } from './scripted-verify.js';

const ctx: CliContext = { outputFormat: 'json', quiet: true };

function fixture(specIds: string[], testSpecs: unknown[], exitCode = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-scripted-verify-'));
  const specFile = path.join(root, 'spec.yaml');
  fs.writeFileSync(
    specFile,
    [
      'version: "2"',
      'name: test contract',
      'target:',
      '  type: web',
      '  url: http://localhost',
      'areas:',
      '  - id: cart',
      '    name: Cart',
      '    behaviors:',
      ...specIds.flatMap((id) => [`      - id: ${id}`, `        description: ${id} works`]),
      '',
    ].join('\n'),
  );
  const output = path.join(root, 'run');
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'package.json'), '{}');
  fs.writeFileSync(path.join(output, 'cart.spec.js'), '');
  const packageDir = path.join(output, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), '{"main":"cli.js"}');
  fs.writeFileSync(
    path.join(packageDir, 'cli.js'),
    `const fs = require('node:fs'); console.log(fs.readFileSync(__dirname + '/report.json', 'utf8')); process.exitCode = ${exitCode};`,
  );
  fs.writeFileSync(
    path.join(packageDir, 'report.json'),
    JSON.stringify({ suites: [{ specs: testSpecs }] }),
  );
  return {
    root,
    specFile,
    output,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const passed = (id: string) => ({
  title: `cart/${id}: ${id} works`,
  ok: true,
  tests: [{ results: [{ status: 'passed' }] }],
});

test('passing selected suite succeeds but marks incomplete contract coverage explicitly', async () => {
  const f = fixture(['add', 'remove'], [passed('add')]);
  try {
    const code = await scriptedVerify({ spec: f.specFile, output: f.output }, ctx);
    const report = JSON.parse(
      fs.readFileSync(path.join(f.output, 'verify-result.json'), 'utf8'),
    ).structuredOutput;
    assert.equal(code, ExitCode.SUCCESS);
    assert.equal(report.suitePass, true);
    assert.equal(report.complete, false);
    assert.equal(report.pass, false);
    assert.equal(
      report.results.find((r: { id: string }) => r.id === 'cart/remove').status,
      'skipped',
    );
  } finally {
    f.cleanup();
  }
});

test('rejects unknown behavior IDs instead of silently dropping evidence', async () => {
  const f = fixture(['add'], [passed('delete')]);
  try {
    assert.equal(
      await scriptedVerify({ spec: f.specFile, output: f.output }, ctx),
      ExitCode.PARSE_ERROR,
    );
    assert.equal(fs.existsSync(path.join(f.output, 'verify-result.json')), false);
  } finally {
    f.cleanup();
  }
});

test('semantic spec lint rejects duplicate IDs before replay', async () => {
  const f = fixture(['add', 'add'], [passed('add')]);
  try {
    assert.equal(
      await scriptedVerify({ spec: f.specFile, output: f.output }, ctx),
      ExitCode.PARSE_ERROR,
    );
    assert.equal(fs.existsSync(path.join(f.output, 'verify-result.json')), false);
  } finally {
    f.cleanup();
  }
});

test('a duplicate failure wins over a passing retry', async () => {
  const f = fixture(
    ['add'],
    [
      passed('add'),
      {
        title: 'cart/add: add item works on another project',
        ok: false,
        tests: [{ results: [{ status: 'failed', error: { message: 'assertion failed' } }] }],
      },
    ],
    1,
  );
  try {
    const code = await scriptedVerify({ spec: f.specFile, output: f.output }, ctx);
    const report = JSON.parse(
      fs.readFileSync(path.join(f.output, 'verify-result.json'), 'utf8'),
    ).structuredOutput;
    assert.equal(code, ExitCode.ASSERTION_FAILURE);
    assert.equal(report.results[0].status, 'failed');
    assert.equal(report.results[0].description, 'add works');
    assert.equal(report.suitePass, false);
  } finally {
    f.cleanup();
  }
});

test('an explicitly skipped test remains skipped and does not pass the suite', async () => {
  const f = fixture(
    ['add'],
    [
      {
        title: 'cart/add: add item works',
        ok: true,
        tests: [{ results: [{ status: 'skipped' }] }],
      },
    ],
  );
  try {
    const code = await scriptedVerify({ spec: f.specFile, output: f.output }, ctx);
    const report = JSON.parse(
      fs.readFileSync(path.join(f.output, 'verify-result.json'), 'utf8'),
    ).structuredOutput;
    assert.equal(code, ExitCode.ALL_UNTESTED);
    assert.equal(report.results[0].status, 'skipped');
    assert.equal(report.suitePass, false);
    assert.equal(report.pass, false);
  } finally {
    f.cleanup();
  }
});

test('empty/unresolvable runner paths are nonzero', async () => {
  const f = fixture(['add'], [passed('add')]);
  try {
    fs.rmSync(path.join(f.output, 'node_modules'), { recursive: true, force: true });
    assert.equal(
      await scriptedVerify({ spec: f.specFile, output: f.output }, ctx),
      ExitCode.RUNNER_ERROR,
    );
  } finally {
    f.cleanup();
  }
});

test('a failed later invocation removes a stale successful result', async () => {
  const f = fixture(['add'], [passed('add')]);
  try {
    assert.equal(
      await scriptedVerify({ spec: f.specFile, output: f.output }, ctx),
      ExitCode.SUCCESS,
    );
    const resultFile = path.join(f.output, 'verify-result.json');
    assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).structuredOutput.pass, true);

    fs.rmSync(path.join(f.output, 'node_modules'), { recursive: true, force: true });
    assert.equal(
      await scriptedVerify({ spec: f.specFile, output: f.output }, ctx),
      ExitCode.RUNNER_ERROR,
    );
    assert.equal(fs.existsSync(resultFile), false);
  } finally {
    f.cleanup();
  }
});
