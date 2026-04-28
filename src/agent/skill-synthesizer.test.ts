import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultDraftsDir, heuristicDescribe, listDrafts, setDraftStatus, synthesizeDraft } from './skill-synthesizer.js';
import type { CandidatePattern } from './pattern-miner.js';

function tmpSpec(): { specPath: string; draftsDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-syn-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { specPath, draftsDir: defaultDraftsDir(specPath), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const samplePattern: CandidatePattern = {
  id: 'pat_abc123',
  signature: 'user/browser:click → user/browser:input → user/browser:click',
  tokens: [
    { role: 'user', kind: 'browser:click' },
    { role: 'user', kind: 'browser:input' },
    { role: 'user', kind: 'browser:click' },
  ],
  occurrences: 6,
  sessionCount: 3,
  examples: [
    {
      sessionId: 'ses_1',
      events: [
        { id: 1, sessionId: 'ses_1', ts: '2026-04-27T10:00:00Z', role: 'user', kind: 'browser:click', content: 'click signup button', tags: null },
        { id: 2, sessionId: 'ses_1', ts: '2026-04-27T10:00:01Z', role: 'user', kind: 'browser:input', content: 'type email address', tags: null },
        { id: 3, sessionId: 'ses_1', ts: '2026-04-27T10:00:02Z', role: 'user', kind: 'browser:click', content: 'click submit button', tags: null },
      ],
    },
  ],
};

test('heuristicDescribe: produces a usable draft from a pattern', () => {
  const desc = heuristicDescribe(samplePattern);
  assert.match(desc.name, /^mined-/);
  assert.match(desc.body, /Mined recurring sequence/);
  assert.match(desc.body, /Examples/);
  assert.ok(desc.tags?.includes('mined'));
});

test('synthesizeDraft: writes draft to disk with frontmatter', async () => {
  const { specPath, draftsDir, cleanup } = tmpSpec();
  try {
    const r = await synthesizeDraft(samplePattern, { specPath });
    assert.equal(r.status, 'pending');
    assert.ok(fs.existsSync(r.filePath));
    const text = fs.readFileSync(r.filePath, 'utf-8');
    assert.match(text, /^---/);
    assert.match(text, /pattern_id:/);
    assert.match(text, /Mined recurring sequence/);
    assert.equal(path.dirname(r.filePath), draftsDir);
  } finally {
    cleanup();
  }
});

test('listDrafts: round-trips written drafts', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    await synthesizeDraft(samplePattern, { specPath });
    const drafts = listDrafts(specPath);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].pattern.signature, samplePattern.signature);
    assert.equal(drafts[0].status, 'pending');
  } finally {
    cleanup();
  }
});

test('setDraftStatus: flips pending to approved on disk', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const r = await synthesizeDraft(samplePattern, { specPath });
    setDraftStatus(r.filePath, 'approved');
    const drafts = listDrafts(specPath);
    assert.equal(drafts[0].status, 'approved');
  } finally {
    cleanup();
  }
});

test('synthesizeDraft: respects custom describer (e.g. LLM-backed)', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const describer = (p: CandidatePattern) => ({
      name: 'verify-signup-flow',
      description: 'Verify the signup flow happy path with empty-state probing.',
      body: '## Custom workflow\n\n1. Navigate to /signup\n2. Probe empty form submit\n',
      tags: ['signup', 'verification'],
    });
    const r = await synthesizeDraft(samplePattern, { specPath, describe: describer });
    assert.equal(r.skill.name, 'verify-signup-flow');
    const text = fs.readFileSync(r.filePath, 'utf-8');
    assert.match(text, /Custom workflow/);
    assert.match(text, /verify-signup-flow/);
  } finally {
    cleanup();
  }
});
