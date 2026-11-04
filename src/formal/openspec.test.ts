import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFormalLine, scanSpecMarkdown } from './openspec.js';

const spec = `# Snooze

## Purpose
Workers can be snoozed.

Formal: quint formal/stray.qnt x

## Requirements

### Requirement: Resumed worker works again
A resumed worker SHALL work again once any snooze lapses.

- Formal: quint formal/snooze.qnt eventuallyWorking temporal main=snoozeResume
- Formal: \`quint formal/snooze.qnt eventuallyWorking temporal main=snoozeResumeBefore expect=fails\`

#### Scenario: Resume after snooze
- **WHEN** an operator resumes a snoozed worker
- **THEN** it works again

\`\`\`text
Formal: quint ignored.qnt inside-a-fence
\`\`\`

### Requirement: Snooze is bounded
The system MUST cap snoozes.

**Formal:** lean formal/Snooze.lean Snooze.capped
Formal: quint formal/snooze.qnt capped bogus

### Requirement: Unlinked
The system SHALL log.
`;

test('reads Formal lines under each requirement, ignoring fences and reporting strays', () => {
  const scan = scanSpecMarkdown(spec, 'snooze', 'openspec/specs/snooze/spec.md');
  assert.deepEqual(scan.requirementIds, [
    'snooze/Resumed worker works again',
    'snooze/Snooze is bounded',
    'snooze/Unlinked',
  ]);
  const summary = scan.references.map((ref) => [
    ref.requirementId,
    ref.source.line,
    ref.check?.tool ?? null,
    ref.check?.expect ?? null,
    ref.error ? 'error' : 'ok',
  ]);
  assert.deepEqual(summary, [
    ['snooze/(none)', 6, null, null, 'error'],
    ['snooze/Resumed worker works again', 13, 'quint', 'holds', 'ok'],
    ['snooze/Resumed worker works again', 14, 'quint', 'fails', 'ok'],
    ['snooze/Snooze is bounded', 27, 'lean', 'holds', 'ok'],
    ['snooze/Snooze is bounded', 28, null, null, 'error'],
  ]);
  assert.match(scan.references[4].error ?? '', /Unknown property kind bogus/);
});

test('Quint links default to an invariant that must hold under TLC', () => {
  assert.deepEqual(parseFormalLine('quint formal/c.qnt safe'), {
    tool: 'quint',
    file: 'formal/c.qnt',
    property: 'safe',
    kind: 'invariant',
    mode: 'verify',
    backend: 'tlc',
    expect: 'holds',
  });
  assert.deepEqual(parseFormalLine('quint c.qnt safe backend=apalache'), {
    tool: 'quint',
    file: 'c.qnt',
    property: 'safe',
    kind: 'invariant',
    mode: 'verify',
    backend: 'apalache',
    expect: 'holds',
    maxSteps: 10,
  });
  const simulated = parseFormalLine('quint c.qnt safe mode=simulate max-steps=5 samples=3 seed=1');
  assert.equal(simulated.tool === 'quint' && simulated.backend, 'typescript');
});

test('rejects options that do not apply to the chosen tool, backend or mode', () => {
  const cases: Array<[string, RegExp]> = [
    ['quint c.qnt', /Expected/],
    ['tla c.tla p', /Unknown formal tool/],
    ['quint c.qnt p max-steps=4', /apalache only/],
    ['quint c.qnt p expect=maybe', /expect must be one of/],
    ['quint c.qnt p temporal mode=simulate max-steps=1 samples=1 seed=1', /mode=verify/],
    ['quint c.qnt p mode=simulate', /requires max-steps, samples and seed/],
    ['quint c.qnt p seed=1', /mode=simulate only/],
    ['quint c.qnt p depth=3', /Unknown Quint option depth/],
    ['quint c.qnt p expect=holds expect=fails', /Repeated option/],
    ['lean P.lean T expect=fails', /expect=holds only/],
    ['quint c.qnt p Formal: quint c.qnt q', /own list item/],
  ];
  for (const [line, error] of cases) assert.throws(() => parseFormalLine(line), error, line);
});
