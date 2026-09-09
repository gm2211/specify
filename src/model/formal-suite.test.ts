import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFormalManifest, mutateControl } from './formal-manifest.js';
import { verificationVerdict, verifyQuint } from './quint-verifier.js';
import { runFormalSuite } from './formal-suite.js';
import { generateFormalTraces } from './formal-traces.js';
import type { ExecResult, QuintExec } from './quint-runner.js';

const result = (code: number | null, stdout: string, rest = {}): ExecResult => ({
  code,
  stdout,
  stderr: '',
  ...rest,
});
const success =
  'Model checking completed. No error has been found.\n10 states generated, 7 distinct states found';
const counterexample = 'found a counterexample';
const manifest = {
  version: 1,
  quintVersion: '0.32.0',
  apalacheVersion: '0.56.1',
  tlcConfig: 'tlc.json',
  models: [
    {
      id: 'sample',
      main: 'sample',
      file: 'sample.qnt',
      behavior: 'test/safety',
      invariant: 'safe',
      temporal: ['live', 'deadlockFreedom'],
    },
  ],
  controls: [
    { id: 'broken', model: 'sample', invariant: 'safe', replace: { from: 'true', to: 'false' } },
  ],
  traces: [
    {
      id: 'sample-traces',
      model: 'sample',
      seed: 42,
      maxSteps: 1,
      count: 2,
      uniqueInitialStates: 2,
    },
  ],
};
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-formal-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'sample.qnt'), 'module sample { val safe = true }');
  fs.writeFileSync(path.join(root, 'tlc.json'), '{}');
  return {
    manifestPath: path.join(root, 'manifest.json'),
    binary: 'quint',
    output: path.join(root, 'output'),
    cwd: root,
  };
}

test('TLC proof verdicts reject infrastructure errors and malformed success', () => {
  assert.equal(verificationVerdict(result(0, success)), 'verified');
  assert.equal(verificationVerdict(result(1, counterexample)), 'counterexample');
  for (const bad of [
    result(0, counterexample),
    result(1, success),
    result(null, counterexample),
    result(1, 'syntax error'),
    result(0, success, { stdoutTruncated: true }),
    result(1, counterexample, { spawnError: 'timeout' }),
  ]) {
    assert.equal(verificationVerdict(bad), 'error');
  }
});
test('manifest rejects empty suites, duplicates, unknown sources and unsafe log ids', () => {
  assert.throws(() => parseFormalManifest({ ...manifest, models: [] }));
  assert.throws(() =>
    parseFormalManifest({ ...manifest, models: [...manifest.models, ...manifest.models] }),
  );
  assert.throws(() =>
    parseFormalManifest({ ...manifest, controls: [{ ...manifest.controls[0], model: 'missing' }] }),
  );
  assert.throws(() =>
    parseFormalManifest({ ...manifest, models: [{ ...manifest.models[0], id: '../escape' }] }),
  );
  assert.throws(() => parseFormalManifest({ ...manifest, typo: true }));
});
test('negative control must mutate exactly one occurrence', () => {
  assert.equal(mutateControl('guard true', { from: 'true', to: 'false' }), 'guard false');
  for (const from of ['absent', 'true'])
    assert.throws(() => mutateControl('true true', { from, to: 'false' }));
  assert.throws(() => mutateControl('true', { from: 'true', to: 'true' }));
});
test('suite accepts exhaustive proof plus real counterexample and records hashes and temporal properties', async (t) => {
  const options = fixture(t);
  const exec: QuintExec = async (argv) => {
    if (argv[1] === '--version') return result(0, '0.32.0');
    if (argv[1] === 'verify')
      return result(
        argv[2].includes('broken') ? 1 : 0,
        argv[2].includes('broken') ? counterexample : success,
      );
    return result(0, 'metadata');
  };
  const report = await runFormalSuite({ ...options, exec });
  assert.equal(report.pass, true);
  assert.deepEqual(report.checks[0].properties, ['safe', 'live', 'deadlockFreedom']);
  assert.equal(report.checks[0].states, '7');
  assert.equal(report.checks[1].verdict, 'counterexample');
  assert.notEqual(report.checks[0].sha256, report.checks[1].sha256);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(options.output, 'report.json'), 'utf8')),
    report,
  );
});
test('negative control syntax failure fails whole suite; stale report cannot survive', async (t) => {
  const options = fixture(t);
  const exec: QuintExec = async (argv) =>
    argv[1] === '--version'
      ? result(0, '0.32.0')
      : result(
          argv[2]?.includes('broken') ? 1 : 0,
          argv[2]?.includes('broken') ? 'syntax error' : success,
        );
  const failed = await runFormalSuite({ ...options, exec });
  assert.equal(failed.pass, false);
  const wrongVersion: QuintExec = async () => result(0, '0.1.0');
  const report = await runFormalSuite({ ...options, exec: wrongVersion });
  assert.equal(report.pass, false);
  assert.match(report.error!, /Expected Quint/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(options.output, 'report.json'), 'utf8')).pass,
    false,
  );
});
test('checker uses isolated JVM dirs, explicit temporal properties and final unformatted state count', async (t) => {
  const options = fixture(t);
  const directories: string[] = [];
  const exec: QuintExec = async (argv, opts) => {
    directories.push(opts.cwd!);
    assert.match(opts.env!.JAVA_TOOL_OPTIONS!, /-Djava.io.tmpdir=/);
    assert.equal(argv[argv.indexOf('--backend') + 1], 'tlc');
    assert.equal(argv[argv.indexOf('--temporal') + 1], 'live,deadlockFreedom');
    return result(
      0,
      success +
        '\nProgress: 5,160 distinct states found\n10000 states generated, 5160 distinct states found',
    );
  };
  const check = {
    binary: 'quint',
    specPath: options.manifestPath,
    invariant: 'safe',
    temporal: ['live', 'deadlockFreedom'],
    apalacheVersion: '0.56.1',
    tlcConfig: path.join(options.cwd, 'tlc.json'),
    timeoutMs: 1000,
    exec,
  };
  const results = await Promise.all([verifyQuint(check), verifyQuint(check)]);
  assert.equal(results[0].states, '5160');
  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
});
test('trace generation uses existing ITF decoder, collapses stutters and enforces coverage', async (t) => {
  const options = { ...fixture(t), output: '' };
  options.output = path.join(options.cwd, 'traces.json');
  const exec: QuintExec = async (argv) => {
    if (argv[1] === '--version') return result(0, '0.32.0');
    const pattern = argv[argv.indexOf('--out-itf') + 1];
    for (let i = 0; i < 2; i++) {
      const state = { n: { '#bigint': String(i) }, s: { '#set': [i] } };
      fs.writeFileSync(
        pattern.replace('{seq}', String(i)),
        JSON.stringify({ vars: ['n', 's'], states: [state, state] }),
      );
    }
    return result(0, 'simulated');
  };
  const generated = await generateFormalTraces({ ...options, exec });
  assert.equal(generated.kind, 'simulation');
  const corpus = JSON.parse(fs.readFileSync(options.output, 'utf8'));
  assert.deepEqual(corpus.entries[0].traces, [[{ n: 0, s: [0] }], [{ n: 1, s: [1] }]]);
  const changed = { ...manifest, traces: [{ ...manifest.traces[0], uniqueInitialStates: 3 }] };
  fs.writeFileSync(options.manifestPath, JSON.stringify(changed));
  await assert.rejects(generateFormalTraces({ ...options, exec }), /Expected 3 unique/);
});
