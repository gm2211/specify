/**
 * Conformance tests: replay the traces Quint sampled from Specify's own models
 * (`specify trace export`, committed in `formal/traces/`) against the implementation. The test
 * names carry the requirement ids that the specs name with `Verify:` lines.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS_REGION, agentsBody, installAgentsRegion } from '../init/agents.js';
import { regionMarkers } from '../init/managed-regions.js';
import { isValidRun, matchesExpectation } from './check.js';
import { scanOpenSpec } from './openspec.js';
import type { Expectation, FormalStatus } from './types.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

type Itf = { states: Array<Record<string, unknown>> };

function traces(model: string): Itf[] {
  const dir = path.join(repo, 'formal', 'traces', model);
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.itf.json'));
  assert.ok(files.length > 0, `no traces for ${model}; run "specify trace export"`);
  return files.map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Itf);
}

function set<T>(value: unknown): T[] {
  return (value as { '#set': T[] })['#set'];
}

function int(value: unknown): number {
  return typeof value === 'number' ? value : Number((value as { '#bigint': string })['#bigint']);
}

function requirement(id: string, model: string): string {
  return `### Requirement: ${id}\nThe system SHALL ${id}.\n\n- Formal: quint formal/${model}.qnt p\n`;
}

test('formal-check/OpenSpec change overlay: the scanner agrees with every Overlay trace state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-conformance-overlay-'));
  try {
    const mainDir = path.join(root, 'openspec', 'specs', 'cap');
    const deltaDir = path.join(root, 'openspec', 'changes', 'c', 'specs', 'cap');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(deltaDir, { recursive: true });
    let states = 0;
    for (const trace of traces('Overlay')) {
      for (const state of trace.states) {
        const main = set<string>(state.main);
        const delta = set<string>(state.delta);
        const removed = set<string>(state.removed);
        fs.writeFileSync(
          path.join(mainDir, 'spec.md'),
          `## Requirements\n\n${main.map((id) => requirement(id, 'main')).join('\n')}`,
        );
        fs.writeFileSync(
          path.join(deltaDir, 'spec.md'),
          [
            '## MODIFIED Requirements\n',
            ...delta.map((id) => requirement(id, 'change')),
            '## REMOVED Requirements\n',
            ...removed.map((id) => `### Requirement: ${id}\n`),
          ].join('\n'),
        );
        const actual = scanOpenSpec(root, 'c')
          .references.map((ref) => {
            const origin = ref.source.file.startsWith('openspec/changes/') ? 'change' : 'main';
            return `${ref.requirementId.replace('cap/', '')}:${origin}`;
          })
          .sort((a, b) => a.localeCompare(b));
        const expected = set<{ '#tup': [string, string] }>(state.result)
          .map((entry) => entry['#tup'].join(':'))
          .sort((a, b) => a.localeCompare(b));
        assert.deepEqual(actual, expected, JSON.stringify(state));
        states += 1;
      }
    }
    assert.ok(states > 50);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formal-check/Expected outcomes: matchesExpectation agrees with every Verdict trace state', () => {
  const seen = new Set<string>();
  for (const trace of traces('Verdict')) {
    for (const state of trace.states) {
      const status = state.lastStatus as FormalStatus;
      const expect = state.lastExpect as Expectation;
      assert.equal(matchesExpectation(status, expect), state.lastOk, JSON.stringify(state));
      seen.add(status);
    }
  }
  // The sampled traces must exercise the statuses that are never a pass.
  for (const status of ['error', 'timeout', 'unavailable']) assert.ok(seen.has(status), status);
});

test('formal-check/Report and exit status: isValidRun agrees with every Verdict trace state', () => {
  let empty = 0;
  for (const trace of traces('Verdict')) {
    for (const state of trace.states) {
      const oks = state.oks as boolean[];
      assert.equal(isValidRun(oks), state.valid, JSON.stringify(state));
      if (!oks.length) empty += 1;
    }
  }
  assert.ok(empty > 0, 'traces include the empty run');
});

test('init/Managed agent instructions: installing the region from every ManagedRegion trace state leaves exactly one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-conformance-region-'));
  try {
    const target = path.join(root, 'AGENTS.md');
    const own = regionMarkers(AGENTS_REGION);
    const legacyIds = ['spec-workflow', 'intent-workflow'];
    for (const trace of traces('ManagedRegion')) {
      for (const state of trace.states) {
        const notes = Array.from({ length: int(state.userText) }, (_, i) => `User note ${i}.`);
        const blocks = [
          ...notes,
          ...legacyIds.slice(0, int(state.legacy)).map((id) => {
            const markers = regionMarkers(id);
            return `${markers.begin}\nold ${id}\n${markers.end}`;
          }),
          ...Array.from({ length: int(state.regions) }, () => `${own.begin}\nstale\n${own.end}`),
        ];
        fs.writeFileSync(target, blocks.length ? `${blocks.join('\n\n')}\n` : '');
        installAgentsRegion(target, agentsBody('specify'));
        const text = fs.readFileSync(target, 'utf8');
        assert.equal(text.split(own.begin).length - 1, 1, JSON.stringify(state));
        assert.equal(text.split(own.end).length - 1, 1);
        assert.doesNotMatch(text, /spec-workflow|intent-workflow|\nstale\n/);
        for (const note of notes) assert.ok(text.includes(note), note);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
