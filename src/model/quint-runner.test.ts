import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';
import {
  runQuintSimulation,
  spawnQuint,
  isValidQuintBinary,
  QUINT_OUTPUT_CAP_BYTES,
  type QuintExec,
  type ExecResult,
} from './quint-runner.js';

/**
 * A fake `quint` that plays the CLI's role: it reads the `--out-itf <path>`
 * argument out of argv and writes the given ITF document there, exactly as the
 * real binary would — so the runner exercises its full read-back-and-parse path
 * without quint installed. This is the CLI-boundary mock, mirroring how the
 * cli-mcp tests drive the real subprocess through a controlled argv.
 */
function fakeQuint(itf: unknown, opts: { code?: number; stderr?: string } = {}): QuintExec {
  return async (argv): Promise<ExecResult> => {
    const i = argv.indexOf('--out-itf');
    if (i >= 0 && argv[i + 1]) {
      fs.writeFileSync(argv[i + 1], JSON.stringify(itf), 'utf-8');
    }
    return { code: opts.code ?? 0, stdout: '', stderr: opts.stderr ?? '' };
  };
}

/** A fake quint that records the argv it was invoked with AND writes the ITF. */
function capturingQuint(itf: unknown, sink: { argv: string[] }): QuintExec {
  return async (argv): Promise<ExecResult> => {
    sink.argv = argv;
    const i = argv.indexOf('--out-itf');
    if (i >= 0 && argv[i + 1]) fs.writeFileSync(argv[i + 1], JSON.stringify(itf), 'utf-8');
    return { code: 0, stdout: '', stderr: '' };
  };
}

const SAMPLE_ITF = {
  vars: ['url', 'action'],
  states: [
    { url: '/login', action: 'init' },
    { url: '/dashboard', action: 'browser_click' },
  ],
};

test('runQuintSimulation: parses the ITF the fake binary wrote', async () => {
  const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', exec: fakeQuint(SAMPLE_ITF) });
  assert.equal(res.ok, true);
  assert.equal(res.traces.length, 1);
  assert.equal(res.traces[0].states.length, 2);
  assert.equal(res.traces[0].states[1].action, 'browser_click');
  assert.deepEqual(res.itfErrors, []);
});

test('runQuintSimulation: builds a `quint run` argv with the tuning flags', async () => {
  const sink = { argv: [] as string[] };
  await runQuintSimulation({ specPath: '/tmp/auth.qnt', maxSteps: 12, maxSamples: 3, seed: 7, invariant: 'safe', exec: capturingQuint(SAMPLE_ITF, sink) });
  const seen = sink.argv;
  assert.equal(seen[0], 'quint');
  assert.equal(seen[1], 'run');
  assert.ok(seen.includes('--max-steps'));
  assert.equal(seen[seen.indexOf('--max-steps') + 1], '12');
  assert.equal(seen[seen.indexOf('--max-samples') + 1], '3');
  assert.equal(seen[seen.indexOf('--seed') + 1], '7');
  assert.equal(seen[seen.indexOf('--invariant') + 1], 'safe');
  // Spec path is the trailing positional.
  assert.equal(seen[seen.length - 1], '/tmp/auth.qnt');
});

test('runQuintSimulation: cleans up the temp ITF file', async () => {
  let outPath = '';
  const exec: QuintExec = async (argv) => {
    const i = argv.indexOf('--out-itf');
    outPath = argv[i + 1];
    fs.writeFileSync(outPath, JSON.stringify(SAMPLE_ITF), 'utf-8');
    return { code: 0, stdout: '', stderr: '' };
  };
  await runQuintSimulation({ specPath: '/tmp/auth.qnt', exec });
  assert.equal(fs.existsSync(outPath), false);
});

test('runQuintSimulation: a spawn error is a structured failure, not a throw', async () => {
  const exec: QuintExec = async () => ({ code: null, stdout: '', stderr: '', spawnError: 'spawn quint ENOENT' });
  const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', exec });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.includes('could not run quint'));
  assert.equal(res.traces.length, 0);
});

test('runQuintSimulation: non-zero exit is fine when an ITF counterexample was written', async () => {
  // quint exits non-zero on an invariant violation but still writes the ITF.
  const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', exec: fakeQuint(SAMPLE_ITF, { code: 1 }) });
  assert.equal(res.ok, true);
  assert.equal(res.traces.length, 1);
});

test('runQuintSimulation: no ITF output is a failure even on exit 0', async () => {
  const exec: QuintExec = async () => ({ code: 0, stdout: '', stderr: 'nothing written' });
  const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', exec });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.includes('no ITF output'));
});

test('runQuintSimulation: symbolic backend is refused unless the JVM flag is set', async () => {
  const prev = process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC;
  delete process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC;
  try {
    const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', symbolic: true, exec: fakeQuint(SAMPLE_ITF) });
    assert.equal(res.ok, false);
    assert.ok(res.error && res.error.includes('SPECIFY_ENABLE_QUINT_SYMBOLIC'));
  } finally {
    if (prev !== undefined) process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC = prev;
  }
});

test('spawnQuint: caps runaway stdout/stderr at the per-stream bound with truncation flags', async () => {
  // Drive the REAL spawn boundary with node as the child, emitting well past
  // the cap on both streams — the BoundedSink must stop storing at the cap.
  const script =
    `process.stdout.write('o'.repeat(${QUINT_OUTPUT_CAP_BYTES + 4096}));` +
    `process.stderr.write('e'.repeat(${QUINT_OUTPUT_CAP_BYTES + 4096}));`;
  const res = await spawnQuint([process.execPath, '-e', script], { timeoutMs: 30_000 });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.length, QUINT_OUTPUT_CAP_BYTES);
  assert.equal(res.stderr.length, QUINT_OUTPUT_CAP_BYTES);
  assert.equal(res.stdoutTruncated, true);
  assert.equal(res.stderrTruncated, true);
});

test('spawnQuint: output under the cap is untouched and unflagged', async () => {
  const res = await spawnQuint([process.execPath, '-e', "process.stdout.write('hello')"], { timeoutMs: 30_000 });
  assert.equal(res.stdout, 'hello');
  assert.equal(res.stdoutTruncated, false);
  assert.equal(res.stderrTruncated, false);
});

test('isValidQuintBinary: accepts bare names and absolute paths, rejects shell shapes', () => {
  assert.equal(isValidQuintBinary('quint'), true);
  assert.equal(isValidQuintBinary('quint-v2.cmd'), true);
  assert.equal(isValidQuintBinary('/usr/local/bin/quint'), true);
  assert.equal(isValidQuintBinary(process.execPath), true);
  // Relative paths, whitespace, and metacharacters are all rejected.
  assert.equal(isValidQuintBinary(''), false);
  assert.equal(isValidQuintBinary('./quint'), false);
  assert.equal(isValidQuintBinary('bin/quint'), false);
  assert.equal(isValidQuintBinary('quint --evil'), false);
  assert.equal(isValidQuintBinary('quint;rm'), false);
  assert.equal(isValidQuintBinary('$(quint)'), false);
  assert.equal(isValidQuintBinary('quint|cat'), false);
  assert.equal(isValidQuintBinary('quint`x`'), false);
});

test('runQuintSimulation: an invalid binary is a structured config error before any spawn', async () => {
  const exec: QuintExec = async () => {
    throw new Error('exec must not be reached');
  };
  const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', binary: 'quint; rm -rf /', exec });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.includes('invalid quint binary'));
  assert.deepEqual(res.argv, []);
});

test('runQuintSimulation: symbolic uses the `verify` verb when the JVM flag is on', async () => {
  const prev = process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC;
  process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC = '1';
  const sink = { argv: [] as string[] };
  try {
    const res = await runQuintSimulation({ specPath: '/tmp/auth.qnt', symbolic: true, exec: capturingQuint(SAMPLE_ITF, sink) });
    const seen = sink.argv;
    assert.equal(res.ok, true);
    assert.equal(seen[1], 'verify');
    // Random-simulation-only flags are omitted for the symbolic backend.
    assert.equal(seen.includes('--max-samples'), false);
  } finally {
    if (prev === undefined) delete process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC;
    else process.env.SPECIFY_ENABLE_QUINT_SYMBOLIC = prev;
  }
});
