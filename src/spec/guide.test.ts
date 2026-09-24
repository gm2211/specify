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
