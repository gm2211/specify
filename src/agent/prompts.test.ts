import assert from 'node:assert/strict';
import test from 'node:test';
import { getCapturePrompt, getVerifyPrompt, getReplayPrompt } from './prompts.js';

test('getCapturePrompt returns non-empty string with URL', () => {
  const prompt = getCapturePrompt('http://localhost:3000');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('http://localhost:3000'));
  assert.ok(prompt.includes('Exploration Strategy'));
});

test('getVerifyPrompt returns non-empty string with spec and URL', () => {
  const prompt = getVerifyPrompt('spec.yaml', 'http://localhost:3000');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('spec.yaml'));
  assert.ok(prompt.includes('http://localhost:3000'));
  assert.ok(prompt.includes('PASSES'));
});

test('getReplayPrompt returns non-empty string with capture dir and URL', () => {
  const prompt = getReplayPrompt('./captures/baseline', 'http://localhost:3000');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('./captures/baseline'));
  assert.ok(prompt.includes('http://localhost:3000'));
  assert.ok(prompt.includes('traffic.json'));
});
