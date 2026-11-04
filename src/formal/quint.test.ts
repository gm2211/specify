import assert from 'node:assert/strict';
import test from 'node:test';
import { checkQuint, classifyQuintResult, quintArgs } from './quint.js';
import type { ProcessResult, QuintFormalCheck } from './types.js';

const base: ProcessResult = {
  exitCode: 0,
  stdout: '[ok] No violation found',
  stderr: '',
  timedOut: false,
  unavailable: false,
  outputLimit: false,
  durationMs: 12,
};

test('Quint only passes on a zero exit and its explicit success marker', () => {
  const scope = {
    mode: 'verify' as const,
    backend: 'apalache' as const,
    kind: 'invariant' as const,
    maxSteps: 4,
  };
  assert.equal(classifyQuintResult(base, 'bounded-model-check', scope, 'safe').status, 'holds');
  assert.equal(
    classifyQuintResult(
      { ...base, stdout: 'Finished successfully' },
      'bounded-model-check',
      scope,
      'safe',
    ).status,
    'error',
  );
  assert.equal(
    classifyQuintResult(
      { ...base, stdout: '[ok] No violation found\n[violation] Found an issue' },
      'bounded-model-check',
      scope,
      'safe',
    ).status,
    'error',
  );
  assert.equal(
    classifyQuintResult({ ...base, exitCode: 1 }, 'bounded-model-check', scope, 'safe').status,
    'error',
  );
  assert.equal(
    classifyQuintResult(
      { ...base, exitCode: 1, stdout: '[violation] Found an issue' },
      'bounded-model-check',
      scope,
      'safe',
    ).status,
    'fails',
  );
  assert.equal(
    classifyQuintResult({ ...base, unavailable: true }, 'bounded-model-check', scope, 'safe')
      .status,
    'unavailable',
  );
  assert.equal(
    classifyQuintResult({ ...base, timedOut: true }, 'bounded-model-check', scope, 'safe').status,
    'timeout',
  );
  assert.equal(
    classifyQuintResult({ ...base, outputLimit: true }, 'bounded-model-check', scope, 'safe')
      .status,
    'error',
  );
});

const tlc: QuintFormalCheck = {
  tool: 'quint',
  file: 'snooze.qnt',
  property: 'eventuallyWorking',
  kind: 'temporal',
  mode: 'verify',
  backend: 'tlc',
  expect: 'holds',
  main: 'snoozeResume',
};

test('TLC temporal checks pass --temporal and no step bound or Apalache endpoint', async () => {
  let args: string[] = [];
  let ports = 0;
  const outcome = await checkQuint(tlc, '/p/formal/snooze.qnt', {
    executable: 'quint',
    cwd: '/p',
    timeoutMs: 1_000,
    allocatePort: async () => {
      ports++;
      return 1;
    },
    run: async (_executable, received) => {
      args = received;
      return base;
    },
  });
  assert.equal(outcome.status, 'holds');
  assert.equal(outcome.evidence, 'exhaustive-model-check');
  assert.equal(ports, 0);
  assert.deepEqual(args, [
    'verify',
    '/p/formal/snooze.qnt',
    '--backend',
    'tlc',
    '--temporal',
    'eventuallyWorking',
    '--verbosity',
    '3',
    '--main',
    'snoozeResume',
  ]);
});

test('Apalache verification is bounded and pinned to an allocated loopback endpoint', async () => {
  let args: string[] = [];
  const ref: QuintFormalCheck = {
    ...tlc,
    kind: 'invariant',
    backend: 'apalache',
    maxSteps: 9,
    main: undefined,
  };
  const outcome = await checkQuint(ref, '/p/c.qnt', {
    executable: 'quint',
    cwd: '/p',
    timeoutMs: 1_000,
    allocatePort: async () => 18828,
    run: async (_executable, received) => {
      args = received;
      return { ...base, exitCode: 1, stdout: '[violation] Found an issue' };
    },
  });
  assert.equal(outcome.status, 'fails');
  assert.equal(outcome.evidence, 'bounded-model-check');
  assert.deepEqual(outcome.scope, {
    mode: 'verify',
    backend: 'apalache',
    kind: 'invariant',
    maxSteps: 9,
  });
  assert.deepEqual(args, [
    'verify',
    '/p/c.qnt',
    '--backend',
    'apalache',
    '--invariant',
    'eventuallyWorking',
    '--max-steps',
    '9',
    '--verbosity',
    '3',
    '--server-endpoint',
    '127.0.0.1:18828',
  ]);
});

test('simulation uses the TypeScript runner with an explicit bound, sample count and seed', () => {
  const ref: QuintFormalCheck = {
    tool: 'quint',
    file: 'c.qnt',
    property: 'safe',
    kind: 'invariant',
    mode: 'simulate',
    backend: 'typescript',
    expect: 'holds',
    maxSteps: 7,
    samples: 11,
    seed: 23,
  };
  assert.deepEqual(quintArgs(ref, '/p/c.qnt'), [
    'run',
    '/p/c.qnt',
    '--backend',
    'typescript',
    '--invariant',
    'safe',
    '--max-steps',
    '7',
    '--max-samples',
    '11',
    '--seed',
    '23',
    '--verbosity',
    '3',
  ]);
});
