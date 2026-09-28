import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureIntent,
  getIntentContext,
  IntentRecordSchema,
  loadIntentRecords,
} from './records.js';

const base = {
  id: 'keep-search-private',
  statement: 'Search terms stay in this browser.',
  kind: 'decision',
  source: { text: 'Please keep search terms in this browser.' },
  appliesTo: [],
};

async function withPack(run: (pack: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specify-intent-'));
  try {
    await run(path.join(root, 'pack'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('capture preserves exact source wording and refuses overwrite', async () => {
  await withPack(async (pack) => {
    const captured = await captureIntent(pack, base);
    assert.equal(captured.record.source.text, 'Please keep search terms in this browser.');
    assert.equal(
      await readFile(captured.path, 'utf8').then((text) => JSON.parse(text).source.text),
      base.source.text,
    );
    await assert.rejects(captureIntent(pack, { ...base, statement: 'Changed' }), {
      code: 'EEXIST',
    });
  });
});

test('schema requires explicit kind and source; assumptions cannot be implicit', () => {
  assert.equal(IntentRecordSchema.safeParse(base).success, true);
  const { kind: _kind, ...withoutKind } = base;
  const { source: _source, ...withoutSource } = base;
  assert.equal(IntentRecordSchema.safeParse(withoutKind).success, false);
  assert.equal(IntentRecordSchema.safeParse(withoutSource).success, false);
  assert.equal(IntentRecordSchema.safeParse({ ...base, appliesTo: ['../secrets'] }).success, false);
  assert.equal(
    IntentRecordSchema.safeParse({ ...base, appliesTo: ['/etc/passwd'] }).success,
    false,
  );
  assert.equal(IntentRecordSchema.safeParse({ ...base, appliesTo: ['C:/private'] }).success, false);
  assert.equal(
    IntentRecordSchema.safeParse({ ...base, statement: 'x'.repeat(2_001) }).success,
    false,
  );
  assert.equal(
    IntentRecordSchema.safeParse({ ...base, source: { text: 'x'.repeat(8_001) } }).success,
    false,
  );
});

test('context selects exact files and directory prefixes while preserving global decisions', async () => {
  await withPack(async (pack) => {
    await captureIntent(pack, base);
    await captureIntent(pack, {
      ...base,
      id: 'account-export',
      statement: 'Export retains account owner.',
      appliesTo: ['src/account/'],
    });
    await captureIntent(pack, {
      ...base,
      id: 'billing-currency',
      statement: 'Billing uses explicit currency.',
      appliesTo: ['src/billing/currency.ts'],
    });
    await captureIntent(pack, {
      ...base,
      id: 'settings-timezone',
      statement: 'Timezone remains explicit.',
      appliesTo: ['src/settings/timezone.ts'],
    });
    const context = await getIntentContext(pack, {
      paths: ['src/account/export.ts'],
      query: 'CURRENCY billing',
    });
    assert.deepEqual(
      context.records.map((record) => record.id),
      ['account-export', 'billing-currency', 'keep-search-private'],
    );
    assert.equal(context.omitted, 1);
    const byPath = await getIntentContext(pack, { paths: ['src/account/export.ts'] });
    assert.deepEqual(
      byPath.records.map((record) => record.id),
      ['account-export', 'keep-search-private'],
    );
    const byDirectory = await getIntentContext(pack, { paths: ['src/account/'] });
    assert.deepEqual(
      byDirectory.records.map((record) => record.id),
      ['account-export', 'keep-search-private'],
    );
    const byId = await getIntentContext(pack, {
      paths: ['src/account/export.ts'],
      query: 'SETTINGS timezone',
    });
    assert.deepEqual(
      byId.records.map((record) => record.id),
      ['account-export', 'keep-search-private', 'settings-timezone'],
    );
    await assert.rejects(
      getIntentContext(pack, { paths: ['../outside'] }),
      /Invalid intent context path/,
    );
  });
});

test('load rejects malformed filenames, filename mismatch, missing supersession targets and cycles', async () => {
  await withPack(async (pack) => {
    const dir = path.join(pack, 'records');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'not kebab.json'), '{}');
    await assert.rejects(loadIntentRecords(pack), /Malformed intent record filename/);
    await rm(path.join(dir, 'not kebab.json'));
    await writeFile(
      path.join(dir, 'wrong-name.json'),
      JSON.stringify({ ...base, id: 'another-id' }),
    );
    await assert.rejects(loadIntentRecords(pack), /filename\/id mismatch/);
    await rm(path.join(dir, 'wrong-name.json'));
    await writeFile(
      path.join(dir, `${base.id}.json`),
      JSON.stringify({ ...base, supersedes: ['missing-record'] }),
    );
    await assert.rejects(loadIntentRecords(pack), /supersedes missing record/);
    await rm(path.join(dir, `${base.id}.json`));
    await writeFile(
      path.join(dir, 'first.json'),
      JSON.stringify({ ...base, id: 'first', supersedes: ['second'] }),
    );
    await writeFile(
      path.join(dir, 'second.json'),
      JSON.stringify({ ...base, id: 'second', supersedes: ['first'] }),
    );
    await assert.rejects(loadIntentRecords(pack), /Cyclic intent supersession/);
  });
});

test('decision supersedes prior record; proposal cannot retire a decision; symlinked records directory rejected', async () => {
  await withPack(async (pack) => {
    await captureIntent(pack, base);
    await captureIntent(pack, {
      ...base,
      id: 'tentative-rewrite',
      kind: 'proposal',
      supersedes: [base.id],
    });
    const context = await getIntentContext(pack);
    assert.deepEqual(
      context.records.map((record) => record.id),
      ['keep-search-private', 'tentative-rewrite'],
    );
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'specify-intent-link-'));
  try {
    const pack = path.join(root, 'pack');
    const outside = path.join(root, 'outside');
    await mkdir(pack);
    await mkdir(outside);
    await symlink(outside, path.join(pack, 'records'));
    await assert.rejects(captureIntent(pack, base), /Unsafe records directory/);
    await assert.rejects(loadIntentRecords(pack), /Unsafe records directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('decision supersession hides retired record from context while retaining record on disk', async () => {
  await withPack(async (pack) => {
    await captureIntent(pack, { ...base, appliesTo: ['src/search/'] });
    await captureIntent(pack, {
      ...base,
      id: 'search-stays-local',
      statement: 'Search remains local.',
      source: { text: 'Still keep it local.' },
      appliesTo: ['src/search/'],
      supersedes: [base.id],
    });
    const loaded = await loadIntentRecords(pack);
    assert.deepEqual(
      loaded.map((record) => record.id),
      ['keep-search-private', 'search-stays-local'],
    );
    const context = await getIntentContext(pack);
    assert.deepEqual(
      context.records.map((record) => record.id),
      ['search-stays-local'],
    );
  });
});

test('capture validates supersession graph and size before creating files', async () => {
  await withPack(async (pack) => {
    await assert.rejects(
      captureIntent(pack, { ...base, supersedes: ['not-recorded'] }),
      /supersedes missing record/,
    );
    await assert.rejects(readFile(path.join(pack, 'records', `${base.id}.json`)), {
      code: 'ENOENT',
    });
    const oversized = {
      ...base,
      behaviorIds: Array.from({ length: 2_000 }, (_, index) => `area/behavior-${index}`),
    };
    await assert.rejects(captureIntent(pack, oversized), /exceeds 16384 bytes/);
    await assert.rejects(readFile(path.join(pack, 'records', `${base.id}.json`)), {
      code: 'ENOENT',
    });
  });
});
