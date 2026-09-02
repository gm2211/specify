import assert from 'node:assert/strict';
import test from 'node:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Spec, VerificationReport } from '../spec/types.js';
import { SCRIPTED_METHOD } from '../agent/scripted-runner.js';
import { loadProofInput, normalizeOutput, DEFAULT_SCREENSHOT_BYTE_CAP } from './proof-loader.js';
import { renderProofHtml } from './proof-html.js';

// A minimal 1x1 transparent PNG, base64-encoded.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-prove-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writePng(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(PNG_1X1_BASE64, 'base64'));
}

// ---------------------------------------------------------------------------
// CLI fixture
// ---------------------------------------------------------------------------

function buildCliFixture(): { dir: string; cleanup: () => void; spec: Spec } {
  const { dir, cleanup } = tmpDir();

  const cliObservations = [
    {
      step: 0,
      argv: ['./specify', 'spec', 'lint'],
      stdout: '✓ Spec is valid\n',
      stderr: '',
      exitCode: 0,
      cwd: '/repo',
      tsStart: 1,
      tsEnd: 2,
      durationMs: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  ];
  writeJson(path.join(dir, 'cli', 'observations.json'), cliObservations);

  const report: VerificationReport = {
    spec: { name: 'CLI Fixture', version: '2' },
    timestamp: '2026-01-01T00:00:00.000Z',
    pass: false,
    summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    results: [
      {
        id: 'unmatched/cli-evidence-behavior',
        description: 'CLI evidence matching',
        status: 'passed',
        method: 'agent',
        evidence: [
          { type: 'command_output', label: 'lint output', content: '✓ Spec is valid' },
          {
            type: 'command_output',
            label: 'narration',
            content: 'I ran the linter and it was happy and it printed a long confirmation',
          },
          { type: 'command_output', label: 'invocation', content: '$ ./specify spec lint' },
          { type: 'command_output', label: 'step 0', content: 'a summary unrelated to the recorded output' },
          { type: 'command_output', label: 'short', content: 'ok' },
        ],
      },
      {
        id: 'unmatched/scripted-behavior',
        description: 'scripted replay behavior',
        status: 'failed',
        method: SCRIPTED_METHOD,
        evidence: [{ type: 'text', label: 'note', content: 'scripted note' }],
      },
    ],
  };
  writeJson(path.join(dir, 'verify-result.json'), { structuredOutput: report });

  const spec: Spec = {
    version: '2',
    name: 'CLI Fixture',
    target: { type: 'cli', binary: './specify' },
    areas: [],
  };

  return { dir, cleanup, spec };
}

test('CLI evidence: explicit output text matches its recorded step', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-evidence-behavior');
    assert.ok(behavior);
    const ev = behavior!.evidence.find((e) => e.label === 'lint output');
    assert.ok(ev);
    assert.equal(ev!.provenance, 'runner-recorded');
    assert.equal(ev!.observationStep, 0);
    assert.equal(ev!.actual?.kind, 'cli');
  } finally {
    cleanup();
  }
});

test('CLI evidence: unrelated narration is agent-reported', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-evidence-behavior')!;
    const ev = behavior.evidence.find((e) => e.label === 'narration')!;
    assert.equal(ev.provenance, 'agent-reported');
    assert.equal(ev.observationStep, undefined);
  } finally {
    cleanup();
  }
});

test('CLI evidence: argv-naming rule matches "$ argv..." content', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-evidence-behavior')!;
    const ev = behavior.evidence.find((e) => e.label === 'invocation')!;
    assert.equal(ev.provenance, 'runner-recorded');
  } finally {
    cleanup();
  }
});

test('CLI evidence: explicit "step N" label wins even without output overlap', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-evidence-behavior')!;
    const ev = behavior.evidence.find((e) => e.label === 'step 0')!;
    assert.equal(ev.provenance, 'runner-recorded');
    assert.equal(ev.observationStep, 0);
  } finally {
    cleanup();
  }
});

test('CLI evidence: short content below MIN_MATCH_CHARS stays agent-reported', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-evidence-behavior')!;
    const ev = behavior.evidence.find((e) => e.label === 'short')!;
    assert.equal(ev.provenance, 'agent-reported');
  } finally {
    cleanup();
  }
});

test('scripted-replay results: every evidence item is runner-recorded with a scripted actual', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/scripted-behavior')!;
    assert.equal(behavior.evidence.length, 1);
    assert.equal(behavior.evidence[0].provenance, 'runner-recorded');
    assert.equal(behavior.evidence[0].actual?.kind, 'scripted');
  } finally {
    cleanup();
  }
});

test('cliSession carries every recorded step, and matched steps surface in the behavior cliSteps', () => {
  const { dir, cleanup, spec } = buildCliFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    assert.equal(input.cliSession.length, 1);
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-evidence-behavior')!;
    assert.ok(behavior.cliSteps.some((s) => s.step === 0));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Evidence matching is data-driven, not keyed off spec.target.type
// ---------------------------------------------------------------------------

test('a cli-target spec with a recorded browser session gets runner-recorded screenshot evidence and a populated filmstrip', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const shot = path.join(dir, 'capture', 'screenshots', '001-home.png');
    writePng(shot);

    const webObservations = [
      {
        step: 0,
        action: 'navigate',
        success: true,
        urlBefore: '',
        urlAfter: 'http://localhost:3000/',
        tsStart: 1000,
        tsEnd: 1010,
        ax: { error: 'not captured in fixture' },
        screenshot: shot,
        trafficRange: [0, 0],
        consoleRange: [0, 0],
      },
    ];
    writeJson(path.join(dir, 'capture', 'observations.json'), webObservations);

    const report: VerificationReport = {
      spec: { name: 'CLI Target, Web Evidence', version: '2' },
      timestamp: '2026-01-01T00:00:00.000Z',
      pass: true,
      summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      results: [
        {
          id: 'unmatched/cli-target-screenshot-behavior',
          description: 'a cli-target behavior whose agent also drove a browser',
          status: 'passed',
          method: 'agent',
          action_trace: [{ type: 'screenshot', description: 'Captured home page', screenshot: shot }],
          evidence: [{ type: 'screenshot', label: 'home shot', content: shot }],
        },
      ],
    };
    writeJson(path.join(dir, 'verify-result.json'), { structuredOutput: report });

    // The spec declares a cli target, but a verify run's recorded evidence
    // (not the spec's declared target type) decides which matching rules
    // apply — so screenshot evidence must still be cross-referenced here.
    const spec: Spec = {
      version: '2',
      name: 'CLI Target, Web Evidence',
      target: { type: 'cli', binary: './specify' },
      areas: [],
    };

    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/cli-target-screenshot-behavior')!;
    assert.ok(behavior);
    assert.equal(behavior.evidence[0].provenance, 'runner-recorded');
    assert.equal(behavior.evidence[0].screenshotKey, '001-home.png');
    assert.ok(behavior.frames.length > 0);
    assert.equal(behavior.frames[0].key, '001-home.png');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Web fixture
// ---------------------------------------------------------------------------

function buildWebFixture(): { dir: string; cleanup: () => void; spec: Spec } {
  const { dir, cleanup } = tmpDir();

  const shot1 = path.join(dir, 'capture', 'screenshots', '001-home.png');
  const shot2 = path.join(dir, 'capture', 'screenshots', '002-detail.png');
  writePng(shot1);
  writePng(shot2);

  const webObservations = [
    {
      step: 0,
      action: 'navigate',
      success: true,
      urlBefore: '',
      urlAfter: 'http://localhost:3000/',
      tsStart: 1000,
      tsEnd: 1010,
      ax: { error: 'not captured in fixture' },
      screenshot: shot1,
      trafficRange: [0, 0],
      consoleRange: [0, 0],
    },
    {
      step: 1,
      action: 'click',
      success: true,
      urlBefore: 'http://localhost:3000/',
      urlAfter: 'http://localhost:3000/detail',
      tsStart: 2000,
      tsEnd: 2010,
      ax: { error: 'not captured in fixture' },
      screenshot: shot2,
      trafficRange: [0, 0],
      consoleRange: [0, 0],
    },
  ];
  writeJson(path.join(dir, 'capture', 'observations.json'), webObservations);

  const report: VerificationReport = {
    spec: { name: 'Web Fixture', version: '2' },
    timestamp: '2026-01-01T00:00:00.000Z',
    pass: true,
    summary: { total: 2, passed: 2, failed: 0, skipped: 0 },
    results: [
      {
        id: 'unmatched/web-behavior',
        description: 'web behavior',
        status: 'passed',
        method: 'agent',
        action_trace: [
          { type: 'screenshot', description: 'Captured home page', screenshot: shot1 },
          { type: 'screenshot', description: 'Captured a missing page', screenshot: '/nowhere/999-missing.png' },
        ],
        evidence: [{ type: 'screenshot', label: 'home shot', content: shot1 }],
      },
      {
        id: 'unmatched/web-no-frames',
        description: 'web behavior with no derivable filmstrip',
        status: 'passed',
        method: 'agent',
        action_trace: [{ type: 'click', description: 'Clicked start button' }],
      },
    ],
  };
  writeJson(path.join(dir, 'verify-result.json'), { structuredOutput: report });

  const spec: Spec = {
    version: '2',
    name: 'Web Fixture',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [],
  };

  return { dir, cleanup, spec };
}

test('web frames: one frame per on-disk trace screenshot; missing files are dropped and agent-reported', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/web-behavior')!;
    assert.equal(behavior.frames.length, 1);
    assert.equal(behavior.frames[0].key, '001-home.png');
    const missingTraceStep = behavior.trace.find((t) => t.description === 'Captured a missing page')!;
    assert.equal(missingTraceStep.provenance, 'agent-reported');
  } finally {
    cleanup();
  }
});

test('web evidence: screenshot content resolves to a runner-recorded screenshotKey', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/web-behavior')!;
    const ev = behavior.evidence[0];
    assert.equal(ev.provenance, 'runner-recorded');
    assert.equal(ev.screenshotKey, '001-home.png');
  } finally {
    cleanup();
  }
});

test('screenshots default to inline data URIs under the default byte cap', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
      maxScreenshotBytes: DEFAULT_SCREENSHOT_BYTE_CAP,
    });
    const shot = input.screenshots['001-home.png'];
    assert.equal(shot.kind, 'inline');
    if (shot.kind === 'inline') {
      assert.ok(shot.dataUri.startsWith('data:image/png;base64,'));
    }
  } finally {
    cleanup();
  }
});

test('a tiny byte cap forces both screenshots to link with relative POSIX hrefs', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const outputPath = path.join(dir, 'proof.html');
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath,
      generatorVersion: '0.0.0-test',
      maxScreenshotBytes: 10,
    });
    assert.equal(input.integrity.screenshotsEmbedded, 0);
    assert.equal(input.integrity.screenshotsLinked, 2);
    for (const shot of Object.values(input.screenshots)) {
      assert.equal(shot.kind, 'link');
      if (shot.kind === 'link') {
        assert.ok(shot.href.startsWith('capture/screenshots/'));
        assert.ok(!shot.href.includes('\\'));
      }
    }
  } finally {
    cleanup();
  }
});

test('a cap sized to fit exactly one screenshot embeds the first-referenced key and links the rest', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const oneShotBytes = Buffer.from(PNG_1X1_BASE64, 'base64').toString('base64').length;
    const outputPath = path.join(dir, 'proof.html');
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath,
      generatorVersion: '0.0.0-test',
      maxScreenshotBytes: oneShotBytes,
    });
    assert.equal(input.integrity.screenshotsEmbedded, 1);
    assert.equal(input.integrity.screenshotsLinked, 1);
    assert.equal(input.screenshots['001-home.png'].kind, 'inline');
    assert.equal(input.screenshots['002-detail.png'].kind, 'link');
  } finally {
    cleanup();
  }
});

test('a behavior whose trace has neither screenshots nor timestamps gets a filmstripNote', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/web-no-frames')!;
    assert.equal(behavior.frames.length, 0);
    assert.ok(behavior.filmstripNote && behavior.filmstripNote.length > 0);
  } finally {
    cleanup();
  }
});

test('integrity: verify-result.json hash matches an independent digest; presence is reported per file', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    const outputPath = path.join(dir, 'proof.html');
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath,
      generatorVersion: '0.0.0-test',
    });
    const raw = fs.readFileSync(path.join(dir, 'verify-result.json'));
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    const verifyFile = input.integrity.files.find((f) => f.path === 'verify-result.json')!;
    assert.equal(verifyFile.sha256, expected);
    assert.equal(verifyFile.present, true);

    const captureObs = input.integrity.files.find((f) => f.path === 'capture/observations.json')!;
    assert.equal(captureObs.present, true);

    const cliObs = input.integrity.files.find((f) => f.path === 'cli/observations.json')!;
    assert.equal(cliObs.present, false);

    assert.ok(input.integrity.regenerateCommand.includes('specify prove'));
  } finally {
    cleanup();
  }
});

test('a malformed capture/observations.json does not throw and still hashes; frames fall back to trace-only', () => {
  const { dir, cleanup, spec } = buildWebFixture();
  try {
    fs.writeFileSync(path.join(dir, 'capture', 'observations.json'), '{ not json', 'utf-8');
    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });
    const captureObs = input.integrity.files.find((f) => f.path === 'capture/observations.json')!;
    assert.equal(captureObs.present, true);
    assert.ok(captureObs.sha256);

    const behavior = input.areas[0].behaviors.find((b) => b.id === 'unmatched/web-behavior')!;
    assert.equal(behavior.frames.length, 1);
    assert.equal(behavior.frames[0].key, '001-home.png');
  } finally {
    cleanup();
  }
});

test('malformed cli/observations.json entries (null, partial, non-object junk) are sanitized, not thrown on', () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeJson(path.join(dir, 'cli', 'observations.json'), [null, { step: 0 }, 'junk']);

    const report: VerificationReport = {
      spec: { name: 'Malformed CLI Observations', version: '2' },
      timestamp: '2026-01-01T00:00:00.000Z',
      pass: true,
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      results: [],
    };
    writeJson(path.join(dir, 'verify-result.json'), { structuredOutput: report });

    const spec: Spec = {
      version: '2',
      name: 'Malformed CLI Observations',
      target: { type: 'cli', binary: './specify' },
      areas: [],
    };

    const input = loadProofInput({
      spec,
      specPath: '/tmp/spec.yaml',
      inputDir: dir,
      outputPath: path.join(dir, 'proof.html'),
      generatorVersion: '0.0.0-test',
    });

    assert.equal(input.cliSession.length, 1);
    assert.deepEqual(input.cliSession[0].argv, []);
    assert.equal(input.cliSession[0].stdout, '');
    assert.equal(input.cliSession[0].exitCode, null);

    // renderProofHtml must not throw on an empty-argv terminal step, and
    // must render the empty-command prompt rather than crashing on
    // argv.join / escapeHtml of missing fields.
    let html = '';
    assert.doesNotThrow(() => {
      html = renderProofHtml(input);
    });
    assert.ok(html.includes('term-screen'));
    assert.ok(html.includes('$'));
  } finally {
    cleanup();
  }
});

test('normalizeOutput strips ANSI escapes and collapses internal whitespace', () => {
  const withAnsi = '[32m✓ Spec[0m   is    valid\r\n\r\n  trailing line  \n';
  assert.equal(normalizeOutput(withAnsi), '✓ Spec is valid\ntrailing line');
});
