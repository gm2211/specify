import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeManagedRegion, regionMarkers } from './managed-regions.js';

test('regionMarkers produces begin/end HTML comments scoped to the region id', () => {
  const { begin, end } = regionMarkers('product-context');
  assert.equal(begin, '<!-- specify:begin:product-context -->');
  assert.equal(end, '<!-- specify:end:product-context -->');
});

test('mergeManagedRegion replaces only the marked region, preserving surrounding hand edits', () => {
  const existing = [
    '# Product: Demo',
    '',
    '_A hand-written intro the human added._',
    '',
    '<!-- specify:begin:product-context -->',
    'OLD generated content [old/anchor]',
    '<!-- specify:end:product-context -->',
    '',
    '## Hand-written appendix',
    'This should survive regeneration untouched.',
    '',
  ].join('\n');

  const { content, hadMarkers } = mergeManagedRegion(
    existing,
    'product-context',
    'NEW generated content [new/anchor]',
  );

  assert.equal(hadMarkers, true);
  assert.match(content, /_A hand-written intro the human added\._/);
  assert.match(content, /## Hand-written appendix/);
  assert.match(content, /This should survive regeneration untouched\./);
  assert.match(content, /NEW generated content \[new\/anchor\]/);
  assert.doesNotMatch(content, /OLD generated content/);
});

test('mergeManagedRegion reports hadMarkers=false and leaves content untouched when markers are absent', () => {
  const existing = '# Hand-authored PRODUCT.md\n\nNo markers here at all.\n';
  const { content, hadMarkers } = mergeManagedRegion(existing, 'product-context', 'generated');
  assert.equal(hadMarkers, false);
  assert.equal(content, existing);
});
