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

test('runCliValidation evaluates inline requirement checks', async () => {
  const cwd = process.cwd();
  const tempDir = mkdtempSync(path.join(tmpdir(), 'specify-checks-'));

  process.chdir(tempDir);
  try {
    const spec: Spec = {
      version: '1.0',
      name: 'Inline Checks Test',
      claims: [
        {
          id: 'inline-claim',
          description: 'Inline-checked requirement grounds this claim',
          grounded_by: {
            requirements: ['checked-requirement'],
          },
        },
      ],
      requirements: [
        {
          id: 'checked-requirement',
          description: 'Requirement verified by inline checks',
          verification: 'agent',
          checks: [
            {
              id: 'check-echo',
              args: ['property-test'],
              expected_exit_code: 0,
              stdout_assertions: [
                { type: 'text_contains', text: 'property-test' },
              ],
            },
          ],
        },
        {
          id: 'failing-check-requirement',
          description: 'Requirement with a failing inline check',
          verification: 'agent',
          checks: [
            {
              id: 'check-wrong',
              args: ['actual-output'],
              expected_exit_code: 0,
              stdout_assertions: [
                { type: 'text_contains', text: 'will-not-match' },
              ],
            },
          ],
        },
      ],
      cli: {
        binary: 'echo',
        commands: [
          {
            id: 'basic-cmd',
            args: ['ok'],
            expected_exit_code: 0,
          },
        ],
      },
    };

    const { report } = await runCliValidation({ spec });

    // Inline checks: passing requirement is verified
    const checkedReq = report.requirements?.find(r => r.id === 'checked-requirement');
    assert.equal(checkedReq?.status, 'verified');
    assert.ok(checkedReq?.check_results?.length === 1);
    assert.equal(checkedReq?.check_results?.[0].status, 'passed');

    // Inline checks: failing requirement is failed
    const failingReq = report.requirements?.find(r => r.id === 'failing-check-requirement');
    assert.equal(failingReq?.status, 'failed');

    // Claim grounded by inline-checked requirement passes
    assert.equal(report.claims?.find(c => c.id === 'inline-claim')?.status, 'passed');

    // Summary: 1 cmd exitcode + 1 passing req + 1 failing req + 1 claim pass = 4 total
    // passed: exitcode(1) + checked-requirement(1) + inline-claim(1) = 3
    // failed: failing-check-requirement(1) = 1
    assert.equal(report.summary.passed, 3);
    assert.equal(report.summary.failed, 1);
  } finally {
    process.chdir(cwd);
  }
});
