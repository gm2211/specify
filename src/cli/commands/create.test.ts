import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveNarrativePath } from './create.js';

test('deriveNarrativePath replaces spec extensions with a narrative suffix', () => {
  assert.equal(deriveNarrativePath('spec.yaml'), 'spec.narrative.md');
  assert.equal(deriveNarrativePath('spec.YML'), 'spec.narrative.md');
  assert.equal(deriveNarrativePath('spec.json'), 'spec.narrative.md');
});

test('deriveNarrativePath appends a narrative suffix for extensionless outputs', () => {
  assert.equal(deriveNarrativePath('./specs/app'), './specs/app.narrative.md');
  assert.equal(deriveNarrativePath('./specs/app.output'), './specs/app.output.narrative.md');
});
