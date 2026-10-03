import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuintFormalCheck } from '../spec/types.js';
import { checkQuint, classifyQuintResult } from './quint.js';
import type { ProcessResult } from './types.js';

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
  const scope = { mode: 'verify' as const, backend: 'apalache' as const, maxSteps: 4 };
  assert.equal(classifyQuintResult(base, 'bounded-model-check', scope, 'safe').status, 'passed');
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
    'failed',
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

test('Quint simulation uses explicit TypeScript backend, bound, sample count and seed', async () => {
  let args: string[] = [];
  const ref: QuintFormalCheck = {
    tool: 'quint',
    file: 'counter.qnt',
    property: 'safe',
    mode: 'simulate',
    main: 'counter',
    maxSteps: 7,
    samples: 11,
    seed: 23,
  };
  const outcome = await checkQuint(ref, '/spec/counter.qnt', {
    executable: '/tools/quint',
    cwd: '/spec',
    timeoutMs: 1_000,
    run: async (_executable, receivedArgs) => {
      args = receivedArgs;
      return base;
    },
  });
  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.evidence, 'simulation');
  assert.deepEqual(outcome.scope, {
    mode: 'simulate',
    backend: 'typescript',
    maxSteps: 7,
    samples: 11,
    seed: 23,
  });
  assert.deepEqual(args, [
    'run',
    '/spec/counter.qnt',
    '--backend',
    'typescript',
    '--invariant',
    'safe',
    '--max-steps',
    '7',
    '--verbosity',
    '3',
    '--main',
    'counter',
    '--max-samples',
    '11',
    '--seed',
    '23',
  ]);
});

test('Quint bounded verification pins Apalache to the local allocated endpoint', async () => {
  let args: string[] = [];
  let requestedHost: string | undefined;
  const ref: QuintFormalCheck = {
    tool: 'quint',
    file: 'counter.qnt',
    property: 'safe',
    mode: 'verify',
    maxSteps: 9,
  };
  const outcome = await checkQuint(ref, '/spec/counter.qnt', {
    executable: '/tools/quint',
    cwd: '/spec',
    timeoutMs: 1_000,
    allocatePort: async () => 18828,
    run: async (_executable, receivedArgs, options) => {
      args = receivedArgs;
      requestedHost = options.cwd;
      return base;
    },
  });
  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.evidence, 'bounded-model-check');
  assert.deepEqual(outcome.scope, { mode: 'verify', backend: 'apalache', maxSteps: 9 });
  assert.deepEqual(args, [
    'verify',
    '/spec/counter.qnt',
    '--backend',
    'apalache',
    '--invariant',
    'safe',
    '--max-steps',
    '9',
    '--verbosity',
    '3',
    '--server-endpoint',
    '127.0.0.1:18828',
  ]);
  assert.equal(requestedHost, '/spec');
});
