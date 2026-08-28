import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { mergeManagedRegion, wrapFreshManagedRegion, writeManagedFile, regionMarkers, proposedPathFor } from './managed-regions.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-managed-regions-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('regionMarkers produces begin/end HTML comments scoped to the region id', () => {
  const { begin, end } = regionMarkers('product-context');
  assert.equal(begin, '<!-- specify:begin:product-context -->');
  assert.equal(end, '<!-- specify:end:product-context -->');
});

test('wrapFreshManagedRegion wraps body between markers under the header', () => {
  const content = wrapFreshManagedRegion('# Product: Demo', 'product-context', 'Hello [area/behavior]');
  assert.match(content, /^# Product: Demo\n\n<!-- specify:begin:product-context -->\nHello \[area\/behavior\]\n<!-- specify:end:product-context -->\n$/);
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

  const { content, hadMarkers } = mergeManagedRegion(existing, 'product-context', 'NEW generated content [new/anchor]');

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

test('proposedPathFor derives a sibling .proposed<ext> path', () => {
  assert.equal(proposedPathFor('/x/PRODUCT.md'), '/x/PRODUCT.proposed.md');
  assert.equal(proposedPathFor('/x/DESIGN'), '/x/DESIGN.proposed.md');
});

test('writeManagedFile creates a fresh managed file when none exists', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const target = path.join(dir, 'PRODUCT.md');
    const result = writeManagedFile({ targetPath: target, regionId: 'product-context', header: '# Product: Demo', body: 'claim [area/behavior]' });

    assert.equal(result.applied, true);
    assert.equal(result.created, true);
    assert.equal(result.hadMarkers, false);
    assert.equal(result.forced, false);
    assert.equal(result.proposedPath, undefined);

    const written = fs.readFileSync(target, 'utf-8');
    assert.match(written, /^# Product: Demo/);
    assert.match(written, /<!-- specify:begin:product-context -->/);
    assert.match(written, /claim \[area\/behavior\]/);
  } finally {
    cleanup();
  }
});

test('writeManagedFile regenerating a managed file preserves content outside the markers', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const target = path.join(dir, 'PRODUCT.md');
    writeManagedFile({ targetPath: target, regionId: 'product-context', header: '# Product: Demo', body: 'v1 claim [area/b1]' });

    // Simulate a human hand-edit outside the managed region.
    const withHandEdit = fs.readFileSync(target, 'utf-8') + '\n## Appendix\nHuman note.\n';
    fs.writeFileSync(target, withHandEdit);

    const result = writeManagedFile({ targetPath: target, regionId: 'product-context', header: '# Product: Demo', body: 'v2 claim [area/b2]' });

    assert.equal(result.applied, true);
    assert.equal(result.hadMarkers, true);
    assert.equal(result.forced, false);

    const finalContent = fs.readFileSync(target, 'utf-8');
    assert.match(finalContent, /v2 claim \[area\/b2\]/);
    assert.doesNotMatch(finalContent, /v1 claim/);
    assert.match(finalContent, /## Appendix/);
    assert.match(finalContent, /Human note\./);
  } finally {
    cleanup();
  }
});

test('writeManagedFile refuses to overwrite an unmanaged (marker-less) file and writes a proposal instead', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const target = path.join(dir, 'PRODUCT.md');
    const original = '# Hand-authored PRODUCT.md\n\nSomething a human wrote, no markers.\n';
    fs.writeFileSync(target, original);

    const result = writeManagedFile({ targetPath: target, regionId: 'product-context', header: '# Product: Demo', body: 'generated claim [area/behavior]' });

    assert.equal(result.applied, false);
    assert.equal(result.hadMarkers, false);
    assert.equal(result.forced, false);
    assert.ok(result.proposedPath);

    // Original file is untouched.
    assert.equal(fs.readFileSync(target, 'utf-8'), original);

    // Proposal file was written with the generated content for review.
    const proposed = fs.readFileSync(result.proposedPath!, 'utf-8');
    assert.match(proposed, /generated claim \[area\/behavior\]/);
  } finally {
    cleanup();
  }
});

test('writeManagedFile with force=true overwrites an unmanaged file in place', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const target = path.join(dir, 'PRODUCT.md');
    fs.writeFileSync(target, '# Hand-authored, no markers\n');

    const result = writeManagedFile({ targetPath: target, regionId: 'product-context', header: '# Product: Demo', body: 'forced claim [area/behavior]', force: true });

    assert.equal(result.applied, true);
    assert.equal(result.forced, true);
    assert.equal(result.proposedPath, undefined);

    const written = fs.readFileSync(target, 'utf-8');
    assert.match(written, /forced claim \[area\/behavior\]/);
    assert.doesNotMatch(written, /Hand-authored, no markers/);
  } finally {
    cleanup();
  }
});
