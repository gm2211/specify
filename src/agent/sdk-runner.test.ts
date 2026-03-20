import assert from 'node:assert/strict';
import test from 'node:test';
import type { SdkRunnerOptions } from './sdk-runner.js';

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
