import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import type { CliContext } from '../types.js';
import { DEFAULT_SCREENSHOT_BYTE_CAP } from '../../report/proof-loader.js';
import { parseScreenshotCap, resolveProvePaths, prove } from './prove.js';

function quietCtx(outputFormat: CliContext['outputFormat'] = 'json'): CliContext {
  return { outputFormat, quiet: true };
}

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-prove-cmd-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function captureStdout(fn: () => Promise<number>): Promise<{ exitCode: number; text: string }> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await fn();
    return { exitCode, text: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('parseScreenshotCap parses valid numbers, and falls back to the default for undefined/invalid input', () => {
  assert.equal(parseScreenshotCap('12345'), 12345);
  assert.equal(parseScreenshotCap(undefined), DEFAULT_SCREENSHOT_BYTE_CAP);
  assert.equal(parseScreenshotCap('abc'), DEFAULT_SCREENSHOT_BYTE_CAP);
});

test('resolveProvePaths defaults the output to proof.html inside the input dir, or resolves an explicit --output', () => {
  const defaulted = resolveProvePaths('/x', undefined);
  assert.equal(defaulted.outputPath, path.join('/x', 'proof.html'));

  const explicit = resolveProvePaths('/x', 'out/report.html');
  assert.equal(explicit.outputPath, path.resolve('out/report.html'));
});

test('prove() reports input_not_found for a missing --input directory', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const missing = path.join(dir, 'nope');
    const { exitCode, text } = await captureStdout(() => prove({ spec: '', input: missing }, quietCtx()));
    assert.equal(exitCode, 10);
    const parsed = JSON.parse(text.trim());
    assert.equal(parsed.error, 'input_not_found');
  } finally {
    cleanup();
  }
});

test('prove() reports verify_result_not_found when the input dir exists but has no verify-result.json', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { exitCode, text } = await captureStdout(() => prove({ spec: '', input: dir }, quietCtx()));
    assert.equal(exitCode, 10);
    const parsed = JSON.parse(text.trim());
    assert.equal(parsed.error, 'verify_result_not_found');
  } finally {
    cleanup();
  }
});

test('prove() happy path: writes proof.html and exits 0', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cli', 'observations.json'),
      JSON.stringify([
        {
          step: 0,
          argv: ['./specify', 'spec', 'lint'],
          stdout: '✓ Spec is valid\n',
          stderr: '',
          exitCode: 0,
          cwd: dir,
          tsStart: 1,
          tsEnd: 2,
          durationMs: 1,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ]),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dir, 'verify-result.json'),
      JSON.stringify({
        structuredOutput: {
          spec: { name: 'Prove Fixture', version: '2' },
          timestamp: '2026-01-01T00:00:00.000Z',
          pass: true,
          summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
          results: [],
        },
      }),
      'utf-8',
    );
    const specPath = path.join(dir, 'spec.yaml');
    fs.writeFileSync(
      specPath,
      [
        'version: "2"',
        'name: Prove Fixture',
        'target:',
        '  type: cli',
        '  binary: ./specify',
        'areas:',
        '  - id: area-a',
        '    name: Area A',
        '    behaviors:',
        '      - id: behavior-a',
        '        description: does the thing',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { exitCode, text } = await captureStdout(() => prove({ spec: specPath, input: dir }, quietCtx()));
    assert.equal(exitCode, 0);
    const outputPath = path.join(dir, 'proof.html');
    assert.ok(fs.existsSync(outputPath));
    const html = fs.readFileSync(outputPath, 'utf-8');
    assert.ok(html.includes('Prove Fixture'));
    const parsed = JSON.parse(text.trim());
    assert.equal(parsed.output, outputPath);
  } finally {
    cleanup();
  }
});

test('CLI subprocess: `specify prove --input <missing> --json` exits 10 with a structured error', (t) => {
  const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
  if (!fs.existsSync(cliEntry)) {
    t.skip('compiled CLI entry not found (run `npm run build` first)');
    return;
  }
  const { dir, cleanup } = tmpDir();
  try {
    const missing = path.join(dir, 'nope');
    const result = spawnSync(process.execPath, [cliEntry, 'prove', '--input', missing, '--json'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    assert.equal(result.status, 10);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.error, 'input_not_found');
  } finally {
    cleanup();
  }
});
