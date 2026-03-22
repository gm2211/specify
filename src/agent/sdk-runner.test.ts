import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBool } from './sdk-runner.js';
import type { SdkRunnerOptions, SdkRunnerResult } from './sdk-runner.js';

test('SdkRunnerOptions interface accepts valid capture options', () => {
  const opts: SdkRunnerOptions = {
    task: 'capture',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Explore the app.',
    url: 'http://localhost:3000',
    outputDir: '/tmp/output',
    headed: false,
  };
  assert.equal(opts.task, 'capture');
  assert.ok(opts.systemPrompt.length > 0);
  assert.ok(opts.userPrompt.length > 0);
});

test('SdkRunnerOptions interface accepts valid verify options', () => {
  const opts: SdkRunnerOptions = {
    task: 'verify',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Verify the app.',
    url: 'http://localhost:3000',
    spec: 'spec.yaml',
    outputDir: '/tmp/output',
  };
  assert.equal(opts.task, 'verify');
  assert.equal(opts.spec, 'spec.yaml');
});

test('SdkRunnerOptions interface accepts valid replay options', () => {
  const opts: SdkRunnerOptions = {
    task: 'replay',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Replay traffic.',
    url: 'http://localhost:3000',
    captureDir: './captures/baseline',
    outputDir: '/tmp/output',
  };
  assert.equal(opts.task, 'replay');
  assert.equal(opts.captureDir, './captures/baseline');
});

test('SdkRunnerOptions accepts new fields: cwd, specOutput, specName', () => {
  const opts: SdkRunnerOptions = {
    task: 'capture',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Explore the app.',
    url: 'http://localhost:3000',
    outputDir: '/tmp/output',
    cwd: '/projects/myapp',
    specOutput: '/tmp/output/spec.yaml',
    specName: 'myapp',
  };
  assert.equal(opts.cwd, '/projects/myapp');
  assert.equal(opts.specOutput, '/tmp/output/spec.yaml');
  assert.equal(opts.specName, 'myapp');
});

test('SdkRunnerResult includes structuredOutput field', () => {
  const result: SdkRunnerResult = {
    result: 'done',
    costUsd: 0.05,
    structuredOutput: { pass: true, summary: 'All checks passed', results: [] },
  };
  assert.equal(result.costUsd, 0.05);
  assert.ok(result.structuredOutput);
  const output = result.structuredOutput as { pass: boolean; summary: string };
  assert.equal(output.pass, true);
  assert.equal(output.summary, 'All checks passed');
});

test('SdkRunnerResult structuredOutput is optional', () => {
  const result: SdkRunnerResult = {
    result: 'done',
    costUsd: 0.01,
  };
  assert.equal(result.structuredOutput, undefined);
});

test('SdkRunnerOptions accepts compare task with remoteUrl and localUrl', () => {
  const opts: SdkRunnerOptions = {
    task: 'compare',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Compare remote against local.',
    remoteUrl: 'https://prod.example.com',
    localUrl: 'http://localhost:3000',
    outputDir: '/tmp/compare',
  };
  assert.equal(opts.task, 'compare');
  assert.equal(opts.remoteUrl, 'https://prod.example.com');
  assert.equal(opts.localUrl, 'http://localhost:3000');
});

test('SdkRunnerResult structured output works for compare', () => {
  const result: SdkRunnerResult = {
    result: 'done',
    costUsd: 0.12,
    structuredOutput: {
      match: false,
      summary: '3 differences found',
      diffs: [
        { page: '/dashboard', description: 'Missing chart widget', remote: 'Chart visible', local: 'Chart missing', severity: 'major' },
      ],
    },
  };
  const output = result.structuredOutput as { match: boolean; diffs: unknown[] };
  assert.equal(output.match, false);
  assert.equal(output.diffs.length, 1);
});

test('extractBool returns boolean for valid field', () => {
  assert.equal(extractBool({ pass: true }, 'pass'), true);
  assert.equal(extractBool({ pass: false }, 'pass'), false);
  assert.equal(extractBool({ match: true }, 'match'), true);
});

test('extractBool returns null for missing, non-object, or non-boolean', () => {
  assert.equal(extractBool(null, 'pass'), null);
  assert.equal(extractBool(undefined, 'pass'), null);
  assert.equal(extractBool('string', 'pass'), null);
  assert.equal(extractBool({}, 'pass'), null);
  assert.equal(extractBool({ pass: 'yes' }, 'pass'), null);
  assert.equal(extractBool({ pass: 1 }, 'pass'), null);
});
