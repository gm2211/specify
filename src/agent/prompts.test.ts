import assert from 'node:assert/strict';
import test from 'node:test';
import { getCapturePrompt, getVerifyPrompt, getReplayPrompt, getComparePrompt } from './prompts.js';

test('getCapturePrompt returns non-empty string with URL and spec output path', () => {
  const prompt = getCapturePrompt('http://localhost:3000', '/tmp/output/spec.yaml');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('http://localhost:3000'));
  assert.ok(prompt.includes('/tmp/output/spec.yaml'));
  assert.ok(prompt.includes('Exploration Strategy'));
});

test('getCapturePrompt does not reference sp CLI commands', () => {
  const prompt = getCapturePrompt('http://localhost:3000', '/tmp/output/spec.yaml');
  assert.ok(!prompt.includes('sp spec generate'), 'should not reference sp spec generate');
  assert.ok(!prompt.includes('sp verify'), 'should not reference sp verify');
  assert.ok(!prompt.includes('sp capture'), 'should not reference sp capture');
});

test('getCapturePrompt includes v2 spec YAML format instructions', () => {
  const prompt = getCapturePrompt('http://localhost:3000', '/tmp/output/spec.yaml');
  assert.ok(prompt.includes('version: "2"'));
  assert.ok(prompt.includes('areas:'));
  assert.ok(prompt.includes('behaviors:'));
});

test('getVerifyPrompt returns non-empty string with spec YAML', () => {
  const specYaml = 'version: "2"\nname: test\nareas: []';
  const prompt = getVerifyPrompt(specYaml);
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('version: "2"'));
});

test('getVerifyPrompt does not reference sp CLI commands', () => {
  const prompt = getVerifyPrompt('version: "2"\nname: test');
  assert.ok(!prompt.includes('sp verify'), 'should not reference sp verify');
  assert.ok(!prompt.includes('sp spec'), 'should not reference sp spec');
});

test('getVerifyPrompt describes structured output format', () => {
  const prompt = getVerifyPrompt('version: "2"\nname: test');
  assert.ok(prompt.includes('pass'));
  assert.ok(prompt.includes('summary'));
  assert.ok(prompt.includes('results'));
  assert.ok(prompt.includes('JSON'));
});

test('getVerifyPrompt mentions behaviors and areas', () => {
  const prompt = getVerifyPrompt('version: "2"\nname: test');
  assert.ok(prompt.includes('areas'), 'should mention areas');
  assert.ok(prompt.includes('behaviors'), 'should mention behaviors');
  assert.ok(prompt.includes('evidence'), 'should mention evidence');
});

test('getCapturePrompt includes assumptions format', () => {
  const prompt = getCapturePrompt('http://localhost:3000', '/tmp/spec.yaml');
  assert.ok(prompt.includes('assumptions:'), 'should show assumptions YAML');
});

test('getReplayPrompt returns non-empty string with capture dir and URL', () => {
  const prompt = getReplayPrompt('./captures/baseline', 'http://localhost:3000');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('./captures/baseline'));
  assert.ok(prompt.includes('http://localhost:3000'));
  assert.ok(prompt.includes('traffic.json'));
});

test('getComparePrompt includes both URLs and output dir', () => {
  const prompt = getComparePrompt('https://prod.example.com', 'http://localhost:3000', '/tmp/compare');
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('https://prod.example.com'));
  assert.ok(prompt.includes('http://localhost:3000'));
  assert.ok(prompt.includes('/tmp/compare'));
});

test('getComparePrompt references both remote and local browser tools', () => {
  const prompt = getComparePrompt('https://prod.example.com', 'http://localhost:3000', '/tmp/compare');
  assert.ok(prompt.includes('mcp__remote__browser_'), 'should reference remote browser tools');
  assert.ok(prompt.includes('mcp__local__browser_'), 'should reference local browser tools');
});

test('getComparePrompt does not reference sp CLI commands', () => {
  const prompt = getComparePrompt('https://prod.example.com', 'http://localhost:3000', '/tmp/compare');
  assert.ok(!prompt.includes('sp '), 'should not reference sp commands');
});

test('getComparePrompt describes structured output format', () => {
  const prompt = getComparePrompt('https://prod.example.com', 'http://localhost:3000', '/tmp/compare');
  assert.ok(prompt.includes('match'));
  assert.ok(prompt.includes('summary'));
  assert.ok(prompt.includes('diffs'));
  assert.ok(prompt.includes('JSON'));
  assert.ok(prompt.includes('severity'));
});

test('getComparePrompt instructs markdown report writing', () => {
  const prompt = getComparePrompt('https://prod.example.com', 'http://localhost:3000', '/tmp/compare');
  assert.ok(prompt.includes('compare-report.md'));
});
