import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specToYaml } from '../spec/parser.js';
import type { Spec } from '../spec/types.js';
import { checkFormal } from './check.js';

function makeSpec(formal: unknown[] = []): Spec {
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
            description: 'Counter remains nonnegative.',
            ...(formal.length
              ? { formal: formal as Spec['areas'][number]['behaviors'][number]['formal'] }
              : {}),
          },
          { id: 'bounded', description: 'Counter has a bounded trace.' },
        ],
      },
    ],
  };
}

async function withFixture(run: (directory: string) => Promise<void>, spec = makeSpec()) {
  const directory = await mkdtemp(join(tmpdir(), 'specify-formal-check-'));
  try {
    await writeFile(join(directory, 'spec.yaml'), specToYaml(spec));
    await writeFile(join(directory, 'Counter.qnt'), 'module Counter\n');
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('zero declared formal references cannot produce a valid report and unlinked behaviors remain visible', async () => {
  await withFixture(async (directory) => {
    const report = await checkFormal({ spec: join(directory, 'spec.yaml') });
    assert.equal(report.valid, false);
    assert.equal(report.scope, 'formal-models-only');
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.unlinkedBehaviorIds, ['counter/safe', 'counter/bounded']);
  });
});

test('runs every reference and returns stable behavior links and original check settings', async () => {
  const refs = [
    {
      tool: 'quint',
      file: 'Counter.qnt',
      property: 'safe',
      mode: 'simulate',
      maxSteps: 4,
      samples: 3,
      seed: 7,
    },
    {
      tool: 'quint',
      file: 'Counter.qnt',
      property: 'safe',
      mode: 'simulate',
      maxSteps: 8,
      samples: 5,
      seed: 12,
    },
  ];
  await withFixture(async (directory) => {
    const executable = join(directory, 'quint-fixture');
    await writeFile(executable, `#!${process.execPath}\nconsole.log('[ok] No violation found');\n`);
    await chmod(executable, 0o700);
    const report = await checkFormal({ spec: join(directory, 'spec.yaml'), quintBin: executable });
    assert.equal(report.valid, true, JSON.stringify(report));
    assert.equal(report.results.length, 2);
    assert.deepEqual(
      report.results.map(({ behaviorId }) => behaviorId),
      ['counter/safe', 'counter/safe'],
    );
    assert.deepEqual(
      report.results.map(({ check }) => check),
      refs,
    );
    assert.deepEqual(report.unlinkedBehaviorIds, ['counter/bounded']);
    assert.equal(report.results[0].outcome.evidence, 'simulation');
    assert.equal(report.results[1].outcome.evidence, 'simulation');
  }, makeSpec(refs));
});

test('missing formal source fails its linked result without preventing remaining checks', async () => {
  const refs = [
    {
      tool: 'quint',
      file: 'Missing.qnt',
      property: 'safe',
      mode: 'simulate',
      maxSteps: 4,
      samples: 3,
      seed: 7,
    },
    {
      tool: 'quint',
      file: 'Counter.qnt',
      property: 'safe',
      mode: 'simulate',
      maxSteps: 4,
      samples: 3,
      seed: 7,
    },
  ];
  await withFixture(async (directory) => {
    const executable = join(directory, 'quint-fixture');
    await writeFile(executable, `#!${process.execPath}\nconsole.log('[ok] No violation found');\n`);
    await chmod(executable, 0o700);
    const report = await checkFormal({ spec: join(directory, 'spec.yaml'), quintBin: executable });
    assert.equal(report.valid, false);
    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].outcome.status, 'error');
    assert.equal(report.results[1].outcome.status, 'passed');
  }, makeSpec(refs));
});

test('rejects an invalid formal path before invoking a tool', async () => {
  const ref = {
    tool: 'quint',
    file: '/etc/passwd',
    property: 'safe',
    mode: 'simulate',
    maxSteps: 4,
    samples: 3,
    seed: 7,
  };
  await withFixture(
    async (directory) => {
      await assert.rejects(
        checkFormal({ spec: join(directory, 'spec.yaml'), quintBin: join(directory, 'missing') }),
        /Invalid spec/,
      );
    },
    makeSpec([ref]),
  );
});
