import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findSpecFiles, resolveSpecPath } from './spec-finder.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-finder-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('findSpecFiles includes manifest-backed spec directories', () => {
  const { dir, cleanup } = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'spec'));
    fs.writeFileSync(path.join(dir, 'spec', 'spec.yaml'), 'version: "2"\n');
    fs.writeFileSync(path.join(dir, 'standalone.spec.yaml'), 'version: "2"\n');

    assert.deepEqual(findSpecFiles(dir), ['spec', 'standalone.spec.yaml']);
  } finally {
    cleanup();
  }
});

test('resolveSpecPath auto-discovers a single spec directory', () => {
  const { dir, cleanup } = tmpDir();
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(dir, 'spec'));
    fs.writeFileSync(path.join(dir, 'spec', 'manifest.yaml'), 'version: "2"\n');
    process.chdir(dir);
    assert.deepEqual(resolveSpecPath(undefined), { path: 'spec', autoDiscovered: true });
  } finally {
    process.chdir(cwd);
    cleanup();
  }
});
