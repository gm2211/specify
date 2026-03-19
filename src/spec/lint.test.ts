import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Spec } from './types.js';
import { lintSpec, lintNarrativeSync } from './lint.js';

test('lintSpec rejects invalid claim refs and invalid description claims', () => {
  const spec: Spec = {
    version: '1.0',
    name: 'Invalid Claim Spec',
    description_claims: ['missing-claim'],
    claims: [
      {
        id: 'claim-1',
        description: 'Broken grounding',
        grounded_by: {
          commands: ['missing-command'],
        },
      },
    ],
    cli: {
      binary: 'echo',
      commands: [],
    },
  };

  const errors = lintSpec(spec);
  assert.ok(errors.some(err => err.rule === 'description-claim-invalid'));
  assert.ok(errors.some(err => err.rule === 'claim-invalid-command-ref'));
});

test('lintNarrativeSync accepts claim refs', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'specify-lint-'));
  const narrativePath = path.join(tempDir, 'app.narrative.md');
  writeFileSync(
    narrativePath,
    [
      '# Test Spec',
      '',
      '## Claims',
      '<!-- spec:claims -->',
      '<!-- spec:claim:claim-1 -->',
      '',
      'This section grounds a normative statement.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const spec: Spec = {
    version: '1.0',
    name: 'Narrative Claim Spec',
    narrative_path: 'app.narrative.md',
    claims: [
      {
        id: 'claim-1',
        description: 'Example claim',
        grounded_by: {
          requirements: ['req-1'],
        },
      },
    ],
    requirements: [
      {
        id: 'req-1',
        description: 'Example requirement',
        verification: 'agent',
      },
    ],
  };

  const errors = lintNarrativeSync(spec, spec.narrative_path!, path.join(tempDir, 'app.spec.yaml'));
  assert.ok(!errors.some(err => err.rule === 'narrative-ref-invalid'));
  assert.ok(!errors.some(err => err.rule === 'narrative-ref-missing' && /claim:claim-1/.test(err.message)));
});
