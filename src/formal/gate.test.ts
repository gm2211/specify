import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGate, writeLock } from './gate.js';
import { definitionText } from './lock.js';
import { scanSpecMarkdown } from './openspec.js';
import { evaluatePolicy } from './policy.js';
import { formatGate } from './report.js';
import { extractCounterexample } from './trace.js';
import { checkVerifyLinks, parseTestReport } from './verify.js';

/** A fake quint: properties named `broken*` have a counterexample unless the module is `Fixed`. */
const fakeQuint = `#!${process.execPath}
const args = process.argv.slice(2);
const property = args[args.findIndex((a) => a === '--invariant' || a === '--temporal') + 1];
const main = args[args.indexOf('--main') + 1];
if (property.startsWith('broken') || main === 'Before') {
  console.log('Error: Invariant q_inv is violated.\\nState 1: <Initial predicate>\\ncount = 0\\n\\nState 2: <undo>\\ncount = -1\\n\\n8 states generated\\n[violation] Found an issue');
  process.exit(1);
}
console.log('[ok] No violation found');
`;

const MODEL = `module Counter {
  var count: int
  // Safety.
  val safe = count >= 0

  val other = true
}
module Before {
  var count: int
  val safe = count >= 0
}
`;

const LINKED = [
  '- Formal: quint formal/Counter.qnt safe main=Counter',
  '- Formal: quint formal/Counter.qnt safe main=Before expect=fails',
  '- Verify: test counter/Never negative',
];

function spec(first: string[], second: string[] = ['- Formal: none (pure output)']): string {
  return [
    '## Requirements',
    '',
    '### Requirement: Never negative',
    'The counter SHALL stay nonnegative.',
    '',
    ...first,
    '',
    '#### Scenario: Increment',
    '- **WHEN** incremented',
    '- **THEN** it is not negative',
    '',
    '### Requirement: Prints',
    'The counter SHALL print.',
    '',
    ...second,
    '',
  ].join('\n');
}

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testcase name="counter/Never negative: replays traces" time="0.1" classname="test"/>
  <testcase name="skipped &amp; ignored" classname="test"><skipped/></testcase>
  <testcase name="red one" classname="test"><failure message="boom">x</failure></testcase>
</testsuites>`;

interface Project {
  root: string;
  quint: string;
  write: (file: string, text: string) => void;
  git: (...args: string[]) => void;
}

async function withProject(run: (project: Project) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-gate-'));
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const git = (...args: string[]): void => {
    const result = spawnSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    write('openspec/specs/counter/spec.md', spec(LINKED));
    write('formal/Counter.qnt', MODEL);
    write('formal/specify.json', JSON.stringify({ policy: 'strict', testReports: ['junit.xml'] }));
    write('junit.xml', JUNIT);
    const quint = path.join(root, 'quint-fixture');
    fs.writeFileSync(quint, fakeQuint, { mode: 0o700 });
    await run({ root, quint, write, git });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('policy: unlinked, waived with links, no before model and no Verify line are findings', () => {
  const scan = scanSpecMarkdown(
    spec(['- Formal: quint formal/Counter.qnt safe', '- Formal: none (why)'], []),
    'counter',
    'spec.md',
  );
  assert.deepEqual(
    evaluatePolicy(scan).map((finding) => [finding.rule, finding.requirementId]),
    [
      ['waived-with-links', 'counter/Never negative'],
      ['no-before', 'counter/Never negative'],
      ['no-verify', 'counter/Never negative'],
      ['unlinked', 'counter/Prints'],
    ],
  );
  assert.deepEqual(evaluatePolicy(scanSpecMarkdown(spec(LINKED), 'counter', 'spec.md')), []);
  const lean = scanSpecMarkdown(
    spec(['- Formal: lean formal/C.lean C.t', '- Verify: test "x"']),
    'counter',
    'spec.md',
  );
  assert.deepEqual(evaluatePolicy(lean), [], 'a Lean theorem needs no before model');
});

test('waivers need a reason, and Verify lines need a test name and a requirement', () => {
  const scan = scanSpecMarkdown(
    spec(['- Formal: none', '- Verify: suite x', '- Verify: test "quoted name"']),
    'counter',
    'spec.md',
  );
  assert.match(scan.references[0].error ?? '', /needs a reason/);
  assert.deepEqual(
    scan.verifies.map((verify) => verify.test ?? verify.error),
    ['Expected "Verify: test <test name>"', 'quoted name'],
  );
  assert.deepEqual(
    scan.waivers.map((waiver) => waiver.reason),
    ['pure output'],
  );
  const stray = scanSpecMarkdown('- Verify: test x\n', 'counter', 'spec.md');
  assert.match(stray.verifies[0].error ?? '', /not under/);
});

test('test reports: JUnit and TAP cases, and how a Verify link is judged', () => {
  const junit = parseTestReport(JUNIT);
  assert.deepEqual(
    junit.map((entry) => entry.status),
    ['passed', 'skipped', 'failed'],
  );
  assert.equal(junit[1].name, 'test skipped & ignored');
  const tap = parseTestReport(
    'TAP version 13\nok 1 - alpha\nnot ok 2 - beta\nok 3 - gamma # SKIP later\n',
  );
  assert.deepEqual(tap, [
    { name: 'alpha', status: 'passed' },
    { name: 'beta', status: 'failed' },
    { name: 'gamma', status: 'skipped' },
  ]);
  const source = { file: 'spec.md', line: 1, text: '' };
  const link = (name: string) => ({ requirementId: 'r', source, test: name });
  const statuses = (cases: ReturnType<typeof parseTestReport> | undefined) =>
    checkVerifyLinks(
      [link('Never negative'), link('ignored'), link('red'), link('absent'), link('e')],
      cases,
    ).map((result) => result.status);
  assert.deepEqual(statuses(junit), ['passed', 'skipped', 'failed', 'missing', 'failed']);
  assert.deepEqual(
    statuses(undefined),
    Array.from({ length: 5 }, () => 'no-report'),
  );
});

test('counterexample traces are extracted from TLC and simulator output', () => {
  const tlc =
    'Error: Invariant q_inv is violated.\nState 1: <Initial predicate>\ncount = 0\n\nState 2: <undo>\ncount = -1\n\n8 states generated, 5 distinct\n[violation] Found an issue';
  assert.equal(
    extractCounterexample(tlc),
    'State 1: <Initial predicate>\ncount = 0\n\nState 2: <undo>\ncount = -1',
  );
  assert.equal(
    extractCounterexample('[State 0] { count: 0 }\n[State 1] { count: -1 }\n[violation] Found'),
    '[State 0] { count: 0 }\n[State 1] { count: -1 }',
  );
  assert.equal(extractCounterexample('[ok] No violation found'), undefined);
});

test('definitionText finds the linked property inside its module', () => {
  const check = {
    tool: 'quint',
    file: 'f.qnt',
    property: 'safe',
    kind: 'invariant',
    mode: 'verify',
    backend: 'tlc',
    expect: 'holds',
  } as const;
  assert.equal(definitionText(MODEL, { ...check, main: 'Before' }), 'val safe = count >= 0');
  assert.equal(definitionText(MODEL, { ...check, property: 'absent' }), undefined);
  const lean = 'theorem t (n : Nat) :\n  n + 0 = n := by simp\n';
  assert.equal(
    definitionText(lean, { tool: 'lean', file: 'C.lean', property: 'C.t', expect: 'holds' }),
    'theorem t (n : Nat) : n + 0 = n :=',
  );
});

test('strict gate: opens when every link, before model, test and the lock are in place', async () => {
  await withProject(async ({ root, quint }) => {
    const unlocked = await runGate({ root, quintBin: quint });
    assert.equal(unlocked.valid, false);
    assert.match(unlocked.failures.join('\n'), /specify\.lock is missing/);

    assert.equal(writeLock(root).changed, true);
    assert.equal(writeLock(root).changed, false);
    const gate = await runGate({ root, quintBin: quint });
    assert.equal(gate.valid, true, JSON.stringify(gate.failures));
    assert.deepEqual(gate.matrix, [
      { requirementId: 'counter/Never negative', model: '1/1 ✓', before: '1/1 ✓', test: '1/1 ✓' },
      { requirementId: 'counter/Prints', model: 'waived', before: '-', test: '-' },
    ]);
    assert.match(formatGate(gate), /Gate open: 2\/2 checks as expected, 1 waived, policy strict/);
  });
});

test('strict gate: closes on policy findings, a red check with its trace, and missing test results', async () => {
  await withProject(async ({ root, quint, write }) => {
    write(
      'openspec/specs/counter/spec.md',
      spec(['- Formal: quint formal/Counter.qnt brokenSafe', '- Verify: test nothing matches'], []),
    );
    writeLock(root);
    const gate = await runGate({ root, quintBin: quint });
    assert.equal(gate.valid, false);
    const text = formatGate(gate);
    assert.match(text, /State 2: <undo>\n\s+count = -1/);
    assert.match(text, /counter\/Prints: no Formal link and no waiver/);
    assert.match(text, /brokenSafe has no expect=fails link/);
    assert.match(text, /test "nothing matches" is missing/);

    const lenient = await runGate({ root, quintBin: quint, policy: 'warn', skipVerify: true });
    assert.deepEqual(lenient.failures.length, 1, 'only the red check fails under warn');
    assert.ok(lenient.warnings.length >= 2);

    fs.rmSync(path.join(root, 'junit.xml'));
    const noReport = await runGate({ root, quintBin: quint });
    assert.match(noReport.failures.join('\n'), /no test report found/);
  });
});

test('warn is the default policy, and a project with requirements but no links still fails', async () => {
  await withProject(async ({ root, quint, write }) => {
    fs.rmSync(path.join(root, 'formal', 'specify.json'));
    const gate = await runGate({ root, quintBin: quint });
    assert.equal(gate.policy, 'warn');
    assert.equal(gate.valid, true);
    assert.match(gate.warnings.join('\n'), /specify\.lock is missing/);

    write('openspec/specs/counter/spec.md', spec([], []));
    const empty = await runGate({ root, quintBin: quint });
    assert.equal(empty.valid, false);
    assert.match(empty.failures.join('\n'), /No Formal lines or waivers/);

    write('formal/specify.json', '{"policy":"loose"}');
    await assert.rejects(runGate({ root }), /policy must be/);
  });
});

test('drift lock: weakening against the base ref fails unless a change proposal names the requirement', async () => {
  await withProject(async ({ root, quint, write, git }) => {
    writeLock(root);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    // Flip the before model's expectation and edit the property, then relock.
    write(
      'openspec/specs/counter/spec.md',
      spec([LINKED[0], '- Formal: quint formal/Counter.qnt safe main=Before', LINKED[2]]),
    );
    write('formal/Counter.qnt', MODEL.replace('val safe = count >= 0\n\n', 'val safe = true\n\n'));
    const stale = await runGate({ root, quintBin: quint });
    assert.equal(stale.lock.status, 'stale');
    writeLock(root);
    const weakened = await runGate({ root, quintBin: quint });
    assert.equal(weakened.lock.status, 'ok');
    assert.deepEqual(
      weakened.lock.weakenings.map((weakening) => [weakening.kind, weakening.covered]),
      [
        ['expect-flipped', false],
        ['definition-changed', false],
      ],
    );
    assert.match(
      weakened.failures.join('\n'),
      /expect-flipped without an OpenSpec change proposal/,
    );

    // Committing does not launder it: CI compares with the base branch.
    git('branch', 'base');
    git('add', '-A');
    git('commit', '-q', '-m', 'weaken');
    const committed = await runGate({ root, quintBin: quint });
    assert.equal(committed.lock.weakenings.length, 0);
    const againstBase = await runGate({ root, quintBin: quint, base: 'base' });
    assert.equal(againstBase.lock.weakenings.length, 2);

    write(
      'openspec/changes/relax/specs/counter/spec.md',
      '## MODIFIED Requirements\n\n### Requirement: Never negative\nThe counter SHALL stay nonnegative.\n\n- Formal: none (relaxed)\n',
    );
    const covered = await runGate({ root, quintBin: quint, base: 'base' });
    assert.ok(covered.lock.weakenings.every((weakening) => weakening.covered));
    assert.doesNotMatch(covered.failures.join('\n'), /change proposal/);

    // Dropping the links for a waiver is also a weakening.
    fs.rmSync(path.join(root, 'openspec', 'changes'), { recursive: true });
    write('openspec/specs/counter/spec.md', spec(['- Formal: none (trust me)']));
    writeLock(root);
    const waived = await runGate({ root, quintBin: quint, base: 'base' });
    assert.deepEqual(
      waived.lock.weakenings.map((weakening) => weakening.kind),
      ['waived'],
    );
  });
});

test('active changes are checked, and --changed runs only links whose spec or model changed', async () => {
  await withProject(async ({ root, quint, write, git }) => {
    writeLock(root);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const quiet = await runGate({ root, quintBin: quint, changed: true });
    assert.equal(quiet.valid, true, JSON.stringify(quiet.failures));
    assert.deepEqual([quiet.totals.checks, quiet.skippedChecks], [0, 2]);

    write(
      'openspec/changes/add-cap/specs/counter/spec.md',
      '## ADDED Requirements\n\n### Requirement: Capped\nThe counter SHALL stop.\n\n- Formal: quint formal/Counter.qnt brokenCap\n',
    );
    const pending = await runGate({ root, quintBin: quint, changed: true });
    assert.deepEqual(
      pending.results.map((result) => [result.requirementId, result.change, result.ok]),
      [['counter/Capped', 'add-cap', false]],
    );
    assert.equal(pending.skippedChecks, 2);
    assert.match(
      pending.failures.join('\n'),
      /counter\/Capped \(change add-cap\): brokenCap has no/,
    );

    const all = await runGate({ root, quintBin: quint });
    assert.equal(all.totals.checks, 3);
  });
});

test('hooks tolerate a missing tool but nothing else', async () => {
  await withProject(async ({ root }) => {
    writeLock(root);
    const missing = path.join(root, 'no-such-quint');
    const strict = await runGate({ root, quintBin: missing });
    assert.equal(strict.valid, false);
    const hook = await runGate({ root, quintBin: missing, tolerateUnavailable: true });
    assert.equal(hook.valid, true, JSON.stringify(hook.failures));
    assert.equal(hook.warnings.length, 2);
  });
});
