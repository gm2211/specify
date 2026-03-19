import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Spec } from '../spec/types.js';
import { runCliValidation } from './runner.js';

test('runCliValidation evaluates grounded claims', async () => {
  const cwd = process.cwd();
  const tempDir = mkdtempSync(path.join(tmpdir(), 'specify-claims-'));

  process.chdir(tempDir);
  try {
    const spec: Spec = {
      version: '1.0',
      name: 'Claims Test Spec',
      claims: [
        {
          id: 'command-claim',
          description: 'Command result grounds this claim',
          grounded_by: {
            commands: ['echo-test'],
          },
        },
        {
          id: 'requirement-claim',
          description: 'Requirement result grounds this claim',
          grounded_by: {
            requirements: ['example-requirement'],
          },
        },
        {
          id: 'missing-command-claim',
          description: 'Missing command grounding fails this claim',
          grounded_by: {
            commands: ['missing-command'],
          },
        },
      ],
      requirements: [
        {
          id: 'example-requirement',
          description: 'Example behavioral requirement',
          verification: 'agent',
        },
      ],
      cli: {
        binary: 'echo',
        commands: [
          {
            id: 'echo-test',
            args: ['hello'],
            expected_exit_code: 0,
            stdout_assertions: [
              { type: 'text_contains', text: 'hello' },
            ],
          },
        ],
      },
    };

    const { report } = await runCliValidation({ spec });

    assert.equal(report.claims?.find(c => c.id === 'command-claim')?.status, 'passed');
    assert.equal(report.claims?.find(c => c.id === 'requirement-claim')?.status, 'failed');
    assert.equal(report.claims?.find(c => c.id === 'missing-command-claim')?.status, 'failed');
    assert.match(
      report.claims?.find(c => c.id === 'missing-command-claim')?.reason ?? '',
      /not found in report/,
    );

    assert.equal(report.summary.passed, 3);
    assert.equal(report.summary.failed, 3);
    assert.equal(report.summary.total, 6);
  } finally {
    process.chdir(cwd);
  }
});
