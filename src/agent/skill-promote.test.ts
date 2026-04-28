import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultSkillsDir,
  listActiveSkills,
  promoteDraft,
  renderActiveSkillsPrompt,
  synthesizeDraft,
} from './skill-synthesizer.js';
import type { CandidatePattern } from './pattern-miner.js';

function tmpSpec(): { specPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-promo-'));
  const specPath = path.join(dir, 'specify.spec.yaml');
  fs.writeFileSync(specPath, '# stub\n');
  return { specPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const samplePattern: CandidatePattern = {
  id: 'pat_xyz',
  signature: 'user/click → user/input',
  tokens: [
    { role: 'user', kind: 'click' },
    { role: 'user', kind: 'input' },
  ],
  occurrences: 4,
  sessionCount: 2,
  examples: [],
};

test('promoteDraft: moves draft to active skills dir and removes original', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const draft = await synthesizeDraft(samplePattern, { specPath });
    assert.ok(fs.existsSync(draft.filePath));
    const result = promoteDraft(draft.filePath, { specPath });
    assert.equal(fs.existsSync(draft.filePath), false, 'original draft must be removed');
    assert.ok(fs.existsSync(result.skillPath));
    assert.match(fs.readFileSync(result.skillPath, 'utf-8'), /status: "approved"/);
  } finally {
    cleanup();
  }
});

test('promoteDraft: refuses to overwrite an existing skill name', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    const first = await synthesizeDraft(samplePattern, { specPath });
    promoteDraft(first.filePath, { specPath });
    const second = await synthesizeDraft(samplePattern, { specPath });
    assert.throws(() => promoteDraft(second.filePath, { specPath }), /already exists/);
  } finally {
    cleanup();
  }
});

test('listActiveSkills + renderActiveSkillsPrompt: surface promoted skills', async () => {
  const { specPath, cleanup } = tmpSpec();
  try {
    assert.equal(listActiveSkills(specPath).length, 0);
    assert.equal(renderActiveSkillsPrompt(specPath), '');

    const draft = await synthesizeDraft(samplePattern, { specPath });
    promoteDraft(draft.filePath, { specPath });

    const skills = listActiveSkills(specPath);
    assert.equal(skills.length, 1);
    assert.match(skills[0].name, /^mined-/);

    const prompt = renderActiveSkillsPrompt(specPath);
    assert.match(prompt, /Available learned skills/);
    assert.match(prompt, /mined-/);
  } finally {
    cleanup();
  }
});

test('defaultSkillsDir resolves next to spec', () => {
  assert.equal(defaultSkillsDir('/tmp/p/specify.spec.yaml'), '/tmp/p/.specify/skills');
});
