import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFormal } from './check.js';
import { formatReport } from './report.js';

const spec = (lines: string[]) => `# Counter

## Requirements

### Requirement: Never negative
The counter SHALL stay nonnegative.
${lines.join('\n')}

#### Scenario: Increment
- **WHEN** incremented
- **THEN** it is not negative

### Requirement: Unlinked
The counter SHALL print.
`;

/** A fake quint that holds for every property except ones named `broken*`. */
const fakeQuint = `#!${process.execPath}
const args = process.argv.slice(2);
const property = args[args.findIndex((a) => a === '--invariant' || a === '--temporal') + 1];
if (property.startsWith('broken')) { console.log('[violation] Found an issue'); process.exit(1); }
console.log('[ok] No violation found');
`;

async function withProject(lines: string[], run: (root: string, quint: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'specify-formal-check-'));
  try {
    await mkdir(join(root, 'openspec', 'specs', 'counter'), { recursive: true });
    await mkdir(join(root, 'formal'));
    await writeFile(join(root, 'openspec', 'specs', 'counter', 'spec.md'), spec(lines));
    await writeFile(join(root, 'formal', 'Counter.qnt'), 'module Counter {}\n');
    const quint = join(root, 'quint-fixture');
    await writeFile(quint, fakeQuint);
    await chmod(quint, 0o700);
    await run(root, quint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('no Formal lines cannot produce a valid report, and unlinked requirements stay visible', async () => {
  await withProject([], async (root) => {
    const report = await checkFormal({ root });
    assert.equal(report.valid, false);
    assert.equal(report.scope, 'formal-models-only');
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.unlinkedRequirementIds, ['counter/Never negative', 'counter/Unlinked']);
    assert.match(formatReport(report), /No Formal lines found/);
  });
});

test('expect=fails passes only when a counterexample is found', async () => {
  const lines = [
    'Formal: quint formal/Counter.qnt nonNegative',
    'Formal: quint formal/Counter.qnt brokenBefore expect=fails',
    'Formal: quint formal/Counter.qnt eventuallyPositive temporal',
  ];
  await withProject(lines, async (root, quint) => {
    const report = await checkFormal({ root, quintBin: quint });
    assert.equal(report.valid, true, JSON.stringify(report, null, 2));
    assert.deepEqual(
      report.results.map((r) => [r.requirementId, r.outcome.status, r.ok]),
      [
        ['counter/Never negative', 'holds', true],
        ['counter/Never negative', 'fails', true],
        ['counter/Never negative', 'holds', true],
      ],
    );
    assert.deepEqual(report.totals, { checks: 3, ok: 3, notOk: 0 });
    assert.deepEqual(report.unlinkedRequirementIds, ['counter/Unlinked']);
    const table = formatReport(report);
    assert.match(
      table,
      /\| counter\/Never negative \| quint brokenBefore \(invariant, tlc\) \| fails \| fails \| ✓ \|/,
    );
    assert.match(table, /3\/3 checks as expected/);
  });
});

test('a property that holds when it should fail, a missing file and a bad line all fail the run', async () => {
  const lines = [
    'Formal: quint formal/Counter.qnt nowFixed expect=fails',
    'Formal: quint formal/Missing.qnt nonNegative',
    'Formal: quint formal/Counter.qnt nonNegative sometimes',
    'Formal: quint formal/Counter.qnt brokenSafety',
  ];
  await withProject(lines, async (root, quint) => {
    const report = await checkFormal({ root, quintBin: quint });
    assert.equal(report.valid, false);
    assert.deepEqual(
      report.results.map((r) => [r.outcome.status, r.ok]),
      [
        ['holds', false],
        ['error', false],
        ['error', false],
        ['fails', false],
      ],
    );
    assert.match(report.results[1].outcome.message ?? '', /not found/);
    assert.match(report.results[2].outcome.message ?? '', /Invalid Formal line/);
    assert.match(formatReport(report), /"before" model no longer shows the bug/);
  });
});

test('--tool filters which links run', async () => {
  const lines = ['Formal: quint formal/Counter.qnt nonNegative', 'Formal: lean formal/C.lean C.t'];
  await withProject(lines, async (root, quint) => {
    const report = await checkFormal({ root, quintBin: quint, tool: 'quint' });
    assert.equal(report.valid, true);
    assert.equal(report.results.length, 1);
  });
});

test('a project without openspec/specs is a setup error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'specify-formal-empty-'));
  try {
    await assert.rejects(checkFormal({ root }), /Run `specify init` first/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--change overlays delta specs: added and modified requirements replace main links, removed ones vanish', async () => {
  await withProject(['- Formal: quint formal/Counter.qnt nonNegative'], async (root, quint) => {
    const delta = join(root, 'openspec', 'changes', 'add-cap', 'specs', 'counter');
    await mkdir(delta, { recursive: true });
    await writeFile(
      join(delta, 'spec.md'),
      [
        '## MODIFIED Requirements',
        '',
        '### Requirement: Never negative',
        'The counter SHALL stay nonnegative and capped.',
        '',
        '- Formal: quint formal/Counter.qnt brokenCapped',
        '',
        '## ADDED Requirements',
        '',
        '### Requirement: Capped',
        'The counter SHALL stop at its cap.',
        '',
        '- Formal: quint formal/Counter.qnt capped temporal',
        '',
        '## REMOVED Requirements',
        '',
        '### Requirement: Unlinked',
        '',
      ].join('\n'),
    );
    const main = await checkFormal({ root, quintBin: quint });
    assert.equal(main.valid, true);
    const withChange = await checkFormal({ root, quintBin: quint, change: 'add-cap' });
    assert.deepEqual(
      withChange.results.map((r) => [r.requirementId, r.check?.property, r.ok]),
      [
        ['counter/Never negative', 'brokenCapped', false],
        ['counter/Capped', 'capped', true],
      ],
    );
    assert.deepEqual(withChange.unlinkedRequirementIds, []);
    await assert.rejects(checkFormal({ root, change: '../x' }), /Invalid change name/);
  });
});
