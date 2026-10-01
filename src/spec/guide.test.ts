import assert from 'node:assert/strict';
import test from 'node:test';
import { getAuthoringGuide } from './guide.js';
import { parseSpec } from './parser.js';

test('every complete authoring-guide example parses with the supported spec schema', () => {
  const examples = getAuthoringGuide().examples;
  assert.ok(examples.length >= 3, 'guide must include runnable examples');
  for (const example of examples) {
    assert.doesNotThrow(() => parseSpec(example.yaml), example.name);
  }
});

test('guide centers existing specs as durable intent source', () => {
  const guide = getAuthoringGuide();
  const tips = guide.tips.join('\n');
  assert.match(tips, /Read existing specs and repository instructions/);
  assert.match(tips, /conversation without code changes/);
  assert.match(tips, /behavior\.source\.text with the exact wording/);
  assert.match(tips, /Never rewrite a requirement to match buggy or incomplete code/);
  assert.doesNotMatch(tips, /intent context|get_intent_context|intent record/i);
});
