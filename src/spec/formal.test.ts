import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSpec, parseSpec, specToYaml } from './parser.js';
import { lintRaw } from './lint.js';
import { splitSpecFileToDirectory } from './size-guard.js';
import { buildProductContext, renderProductMarkdown } from './product-context.js';
import type { FormalCheck, Spec } from './types.js';

const refs: FormalCheck[] = [
  {
    tool: 'quint',
    file: 'Counter.qnt',
    property: 'safe',
    mode: 'simulate',
    maxSteps: 5,
    samples: 20,
    seed: 1,
  },
  { tool: 'quint', file: 'Counter.qnt', property: 'safe', mode: 'verify', maxSteps: 5 },
  { tool: 'lean', file: 'Counter.lean', property: 'Counter.safe' },
];

function contract(formal: unknown = refs): Spec {
  return {
    version: '2',
    name: 'Counter',
    target: { type: 'cli', binary: 'unused' },
    areas: [
      {
        id: 'counter',
        name: 'Counter',
        behaviors: [
          {
            id: 'safe',
            description: 'Counter is nonnegative.',
            source: { text: 'Never let the counter go below zero.' },
            formal: formal as FormalCheck[],
          },
        ],
      },
    ],
  };
}

test('formal references survive YAML roundtrip and context projection without verification claims', () => {
  const parsed = parseSpec(specToYaml(contract()));
  assert.deepEqual(parsed.areas[0].behaviors[0].formal, refs);
  const context = buildProductContext(parsed);
  assert.deepEqual(context.areas[0].behaviorClaims[0].formal, refs);
  const markdown = renderProductMarkdown(context, 'spec.yaml');
  assert.match(markdown, /not checked by this projection/);
  assert.match(markdown, /Counter\.safe/);
  assert.match(markdown, /Never let the counter go below zero\./);
});

test('formal schema requires explicit valid bounds, selectors, and tool-specific fields', () => {
  const simulation = refs[0];
  for (const formal of [
    [],
    [{ ...simulation, seed: undefined }],
    [{ ...simulation, samples: 0 }],
    [{ ...simulation, maxSteps: -1 }],
    [{ ...simulation, seed: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...simulation, property: 'true; arbitrary()' }],
    [{ ...refs[1], seed: 1 }],
    [{ ...refs[2], mode: 'verify' }],
    [{ ...refs[2], file: 'Counter.qnt' }],
    [{ ...refs[2], property: 'Counter.safe\n#eval 1' }],
  ]) {
    assert.equal(lintRaw(JSON.stringify(contract(formal))).valid, false, JSON.stringify(formal));
  }
  for (const file of ['/tmp/Counter.lean', 'C:\\Counter.lean', '\\\\server\\Counter.lean']) {
    assert.equal(lintRaw(JSON.stringify(contract([{ ...refs[2], file }]))).valid, false, file);
  }
});

test('splitting a spec preserves native file targets and stable behavior identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-formal-split-'));
  try {
    const input = join(dir, 'counter.yaml');
    writeFileSync(input, specToYaml(contract()));
    const { outputDir } = splitSpecFileToDirectory(input);
    const behavior = loadSpec(outputDir).areas[0].behaviors[0];
    assert.equal(behavior.id, 'safe');
    assert.deepEqual(behavior.source, contract().areas[0].behaviors[0].source);
    for (const [index, ref] of behavior.formal!.entries()) {
      assert.equal(resolve(outputDir, ref.file), resolve(dir, refs[index].file));
      assert.equal(ref.property, refs[index].property);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
