import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { extractDesignTokens } from './design-tokens.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-design-tokens-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

test('extractDesignTokens returns an empty result when no token sources exist', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
    const result = extractDesignTokens(dir);
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.sources, []);
  } finally {
    cleanup();
  }
});

test('extractDesignTokens reads a nested tokens.json, naming tokens by dotted key path', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'design-tokens.json'), JSON.stringify({
      color: { primary: '#0af', secondary: '#f0a' },
      spacing: { sm: '4px' },
    }));

    const result = extractDesignTokens(dir);
    const names = result.tokens.map((t) => t.name).sort();
    assert.deepEqual(names, ['color.primary', 'color.secondary', 'spacing.sm']);

    const primary = result.tokens.find((t) => t.name === 'color.primary')!;
    assert.equal(primary.value, '#0af');
    assert.equal(primary.category, 'color');
    assert.equal(primary.source, 'design-tokens.json');

    const spacing = result.tokens.find((t) => t.name === 'spacing.sm')!;
    assert.equal(spacing.category, 'spacing');

    assert.deepEqual(result.sources, ['design-tokens.json']);
  } finally {
    cleanup();
  }
});

test('extractDesignTokens reads CSS custom properties', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'src', 'theme.css'), [
      ':root {',
      '  --color-brand: #123456;',
      '  --radius-lg: 12px;',
      '}',
      '',
    ].join('\n'));

    const result = extractDesignTokens(dir);
    const names = result.tokens.map((t) => t.name).sort();
    assert.deepEqual(names, ['color-brand', 'radius-lg']);

    const color = result.tokens.find((t) => t.name === 'color-brand')!;
    assert.equal(color.value, '#123456');
    assert.equal(color.category, 'color');
    assert.equal(color.source, path.join('src', 'theme.css'));

    const radius = result.tokens.find((t) => t.name === 'radius-lg')!;
    assert.equal(radius.category, 'radius');
  } finally {
    cleanup();
  }
});

test('extractDesignTokens does not mistake a "--modifier" class selector for a custom property', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'src', 'theme.css'), [
      ':root {',
      '  --accent: #58a6ff;',
      '}',
      '.btn--primary:hover:not(:disabled) {',
      '  background: rgba(88, 166, 255, 0.25);',
      '}',
      '',
    ].join('\n'));

    const result = extractDesignTokens(dir);
    const names = result.tokens.map((t) => t.name);
    assert.deepEqual(names, ['accent']);
    assert.equal(result.tokens[0].value, '#58a6ff');
  } finally {
    cleanup();
  }
});

test('extractDesignTokens matches back-to-back declarations with no separating whitespace', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'theme.css'), ':root{--a:1px;--b:2px;}\n');
    const result = extractDesignTokens(dir);
    const names = result.tokens.map((t) => t.name).sort();
    assert.deepEqual(names, ['a', 'b']);
  } finally {
    cleanup();
  }
});

test('extractDesignTokens skips node_modules and other ignored directories', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'node_modules', 'some-pkg', 'tokens.json'), JSON.stringify({ color: { primary: '#fff' } }));
    const result = extractDesignTokens(dir);
    assert.deepEqual(result.tokens, []);
  } finally {
    cleanup();
  }
});

test('extractDesignTokens skips unparsable JSON without throwing', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeFile(path.join(dir, 'tokens.json'), '{ not valid json');
    const result = extractDesignTokens(dir);
    assert.deepEqual(result.tokens, []);
  } finally {
    cleanup();
  }
});
