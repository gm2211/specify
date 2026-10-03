import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkLean } from './lean.js';

async function fixture(
  mode: string,
  run: (directory: string, executable: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'specify-lean-test-'));
  const executable = join(directory, 'lean-fixture');
  await writeFile(join(directory, 'Proof.lean'), 'theorem holds : True := True.intro\n');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const mode = ${JSON.stringify(mode)};
const source = process.argv.at(-1);
fs.appendFileSync(${JSON.stringify(join(directory, 'calls'))}, source + '\\n');
if (mode === 'shared-deadline') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
if (process.argv.includes('-o')) {
  if (mode === 'compile-fail') process.exit(1);
  if (mode === 'timeout') setTimeout(() => process.exit(0), 5000);
  else process.exit(0);
} else {
  const contents = fs.readFileSync(source, 'utf8');
  const marker = contents.match(/SPECIFY_PROOF_[a-f0-9]+:/)[0];
  const certificate = {
    theorem: mode === 'wrong-target' ? 'Other.holds' : 'Counter.holds',
    statement: 'True',
    axioms: mode === 'sorry' ? ['sorryAx'] : mode === 'custom' ? ['Counter.assumed'] : ['propext']
  };
  const line = JSON.stringify({severity: 'information', data: marker + JSON.stringify(certificate)});
  if (mode === 'malformed') console.log('not-json');
  else if (mode !== 'missing') console.log(line);
  if (mode === 'duplicate') console.log(line);
  if (mode === 'error-diagnostic') console.log(JSON.stringify({severity:'error',data:'bad proof'}));
  if (mode === 'wrapper-fail') process.exit(1);
}
`,
  );
  await chmod(executable, 0o700);
  try {
    await run(directory, executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function check(directory: string, executable: string, timeoutMs = 5000) {
  return checkLean(
    { tool: 'lean', file: 'Proof.lean', property: 'Counter.holds' },
    join(directory, 'Proof.lean'),
    { executable, cwd: directory, timeoutMs },
  );
}

test('Lean requires a theorem certificate, preserves evidence, and removes temporary files', async () => {
  await fixture('valid', async (directory, executable) => {
    const outcome = await check(directory, executable);
    assert.equal(outcome.status, 'passed');
    assert.equal(outcome.evidence, 'proof');
    assert.equal(outcome.statement, 'True');
    assert.deepEqual(outcome.axioms, ['propext']);
    const callText = await readFile(join(directory, 'calls'), 'utf8');
    const calls = callText.trim().split('\n');
    assert.equal(calls.length, 2);
    for (const file of calls) {
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    }
  });
});

test('Lean never promotes sorry or custom assumptions into a passed proof', async () => {
  for (const [mode, axiom] of [
    ['sorry', 'sorryAx'],
    ['custom', 'Counter.assumed'],
  ]) {
    await fixture(mode, async (directory, executable) => {
      const outcome = await check(directory, executable);
      assert.equal(outcome.status, 'failed');
      assert.deepEqual(outcome.axioms, [axiom]);
      assert.match(outcome.message!, /unaccepted axioms/);
    });
  }
});

test('Lean rejects missing, duplicate, malformed, wrong-target and error certificates', async () => {
  for (const mode of ['missing', 'duplicate', 'malformed', 'wrong-target', 'error-diagnostic']) {
    await fixture(mode, async (directory, executable) => {
      const outcome = await check(directory, executable);
      assert.equal(outcome.status, 'error', mode);
    });
  }
});

test('Lean requires successful source and wrapper compilation', async () => {
  for (const mode of ['compile-fail', 'wrapper-fail']) {
    await fixture(mode, async (directory, executable) => {
      const outcome = await check(directory, executable);
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.exitCode, 1);
      const callText = await readFile(join(directory, 'calls'), 'utf8');
      const calls = callText.trim().split('\n');
      assert.equal(calls.length, mode === 'compile-fail' ? 1 : 2);
    });
  }
});

test('Lean timeout and unavailable executables cannot pass', async () => {
  await fixture('timeout', async (directory, executable) => {
    const timedOut = await check(directory, executable, 200);
    assert.equal(timedOut.status, 'timeout');
    const missing = await check(directory, join(directory, 'absent'));
    assert.equal(missing.status, 'unavailable');
  });
});

test('Lean shares one deadline across source compilation and certificate inspection', async () => {
  await fixture('shared-deadline', async (directory, executable) => {
    // Each phase finishes inside five seconds, but both cannot. Keep two seconds
    // of startup headroom so concurrent test workers do not consume phase one's budget.
    const outcome = await check(directory, executable, 5000);
    assert.equal(outcome.status, 'timeout');
    const callText = await readFile(join(directory, 'calls'), 'utf8');
    assert.equal(callText.trim().split('\n').length, 2);
  });
});
