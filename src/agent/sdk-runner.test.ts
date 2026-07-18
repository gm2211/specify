import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  extractBool,
  _internals,
  redactUrlUserinfo,
  composeSystemPrompt,
  buildRunContextBundle,
  writeRunContextBundle,
} from './sdk-runner.js';
import type { SdkRunnerOptions, SdkRunnerResult, RunContextBundle } from './sdk-runner.js';

test('SdkRunnerOptions interface accepts valid capture options', () => {
  const opts: SdkRunnerOptions = {
    task: 'capture',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Explore the app.',
    url: 'http://localhost:3000',
    outputDir: '/tmp/output',
    headed: false,
  };
  assert.equal(opts.task, 'capture');
  assert.ok(opts.systemPrompt.length > 0);
  assert.ok(opts.userPrompt.length > 0);
});

test('SdkRunnerOptions interface accepts valid verify options', () => {
  const opts: SdkRunnerOptions = {
    task: 'verify',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Verify the app.',
    url: 'http://localhost:3000',
    spec: 'spec.yaml',
    outputDir: '/tmp/output',
  };
  assert.equal(opts.task, 'verify');
  assert.equal(opts.spec, 'spec.yaml');
});

test('SdkRunnerOptions interface accepts valid replay options', () => {
  const opts: SdkRunnerOptions = {
    task: 'replay',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Replay traffic.',
    url: 'http://localhost:3000',
    captureDir: './captures/baseline',
    outputDir: '/tmp/output',
  };
  assert.equal(opts.task, 'replay');
  assert.equal(opts.captureDir, './captures/baseline');
});

test('SdkRunnerOptions accepts new fields: cwd, specOutput, specName', () => {
  const opts: SdkRunnerOptions = {
    task: 'capture',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Explore the app.',
    url: 'http://localhost:3000',
    outputDir: '/tmp/output',
    cwd: '/projects/myapp',
    specOutput: '/tmp/output/spec.yaml',
    specName: 'myapp',
  };
  assert.equal(opts.cwd, '/projects/myapp');
  assert.equal(opts.specOutput, '/tmp/output/spec.yaml');
  assert.equal(opts.specName, 'myapp');
});

test('SdkRunnerResult includes structuredOutput field', () => {
  const result: SdkRunnerResult = {
    result: 'done',
    costUsd: 0.05,
    structuredOutput: { pass: true, summary: 'All checks passed', results: [] },
  };
  assert.equal(result.costUsd, 0.05);
  assert.ok(result.structuredOutput);
  const output = result.structuredOutput as { pass: boolean; summary: string };
  assert.equal(output.pass, true);
  assert.equal(output.summary, 'All checks passed');
});

test('SdkRunnerResult structuredOutput is optional', () => {
  const result: SdkRunnerResult = {
    result: 'done',
    costUsd: 0.01,
  };
  assert.equal(result.structuredOutput, undefined);
});

test('SdkRunnerOptions accepts compare task with remoteUrl and localUrl', () => {
  const opts: SdkRunnerOptions = {
    task: 'compare',
    systemPrompt: 'You are Specify...',
    userPrompt: 'Compare remote against local.',
    remoteUrl: 'https://prod.example.com',
    localUrl: 'http://localhost:3000',
    outputDir: '/tmp/compare',
  };
  assert.equal(opts.task, 'compare');
  assert.equal(opts.remoteUrl, 'https://prod.example.com');
  assert.equal(opts.localUrl, 'http://localhost:3000');
});

test('SdkRunnerResult structured output works for compare', () => {
  const result: SdkRunnerResult = {
    result: 'done',
    costUsd: 0.12,
    structuredOutput: {
      match: false,
      summary: '3 differences found',
      diffs: [
        { page: '/dashboard', description: 'Missing chart widget', remote: 'Chart visible', local: 'Chart missing', severity: 'major' },
      ],
    },
  };
  const output = result.structuredOutput as { match: boolean; diffs: unknown[] };
  assert.equal(output.match, false);
  assert.equal(output.diffs.length, 1);
});

test('extractBool returns boolean for valid field', () => {
  assert.equal(extractBool({ pass: true }, 'pass'), true);
  assert.equal(extractBool({ pass: false }, 'pass'), false);
  assert.equal(extractBool({ match: true }, 'match'), true);
});

test('extractBool returns null for missing, non-object, or non-boolean', () => {
  assert.equal(extractBool(null, 'pass'), null);
  assert.equal(extractBool(undefined, 'pass'), null);
  assert.equal(extractBool('string', 'pass'), null);
  assert.equal(extractBool({}, 'pass'), null);
  assert.equal(extractBool({ pass: 'yes' }, 'pass'), null);
  assert.equal(extractBool({ pass: 1 }, 'pass'), null);
});

test('envNumber returns fallback when the env var is unset', () => {
  delete process.env.SPECIFY_TEST_ENV_NUMBER;
  assert.equal(_internals.envNumber('SPECIFY_TEST_ENV_NUMBER', 5), 5);
});

test('envNumber parses integer and decimal overrides', () => {
  try {
    process.env.SPECIFY_TEST_ENV_NUMBER = '25';
    assert.equal(_internals.envNumber('SPECIFY_TEST_ENV_NUMBER', 5), 25);
    process.env.SPECIFY_TEST_ENV_NUMBER = '12.5';
    assert.equal(_internals.envNumber('SPECIFY_TEST_ENV_NUMBER', 5), 12.5);
  } finally {
    delete process.env.SPECIFY_TEST_ENV_NUMBER;
  }
});

test('envNumber falls back on garbage, empty, zero, and negative values', () => {
  try {
    for (const bad of ['abc', '', '  ', '0', '-3', 'NaN', 'Infinity']) {
      process.env.SPECIFY_TEST_ENV_NUMBER = bad;
      assert.equal(_internals.envNumber('SPECIFY_TEST_ENV_NUMBER', 5), 5, `expected fallback for ${JSON.stringify(bad)}`);
    }
  } finally {
    delete process.env.SPECIFY_TEST_ENV_NUMBER;
  }
});

// ---------------------------------------------------------------------------
// SP-bhm: per-run repro bundle (run-context.json)
// ---------------------------------------------------------------------------

test('redactUrlUserinfo strips username and password from a URL', () => {
  const redacted = redactUrlUserinfo('https://alice:s3cret@example.com/path?x=1');
  assert.equal(redacted, 'https://example.com/path?x=1');
  assert.ok(!redacted.includes('alice'));
  assert.ok(!redacted.includes('s3cret'));
});

test('redactUrlUserinfo is a no-op for URLs without credentials', () => {
  assert.equal(redactUrlUserinfo('https://example.com/path'), 'https://example.com/path');
});

test('redactUrlUserinfo returns the input unchanged when not a parseable URL', () => {
  assert.equal(redactUrlUserinfo('./my-cli-binary'), './my-cli-binary');
});

test('composeSystemPrompt is a no-op when no parts are injected', () => {
  assert.equal(composeSystemPrompt('base prompt', {}), 'base prompt');
});

test('composeSystemPrompt prepends memory preamble innermost, then skills, then layered context', () => {
  const composed = composeSystemPrompt('BASE', {
    layeredContext: 'LAYERED',
    skillsText: 'SKILLS',
    memoryPreamble: 'MEMORY',
  });
  assert.equal(composed, 'MEMORY\n\nSKILLS\n\nLAYERED\n\nBASE');
});

test('composeSystemPrompt skips falsy/empty parts', () => {
  const composed = composeSystemPrompt('BASE', { layeredContext: '', skillsText: undefined, memoryPreamble: 'MEMORY' });
  assert.equal(composed, 'MEMORY\n\nBASE');
});

test('buildRunContextBundle computes systemPromptSha256 matching a manual sha256', () => {
  const systemPrompt = 'You are Specify verifying a spec.';
  const bundle = buildRunContextBundle({
    runId: 'run_abcd1234',
    systemPrompt,
    model: 'claude-opus-4-6',
    maxTurns: 200,
    maxBudgetUsd: 5,
  });
  const expected = createHash('sha256').update(systemPrompt, 'utf-8').digest('hex');
  assert.equal(bundle.systemPromptSha256, expected);
  assert.equal(bundle.runId, 'run_abcd1234');
  assert.equal(bundle.model, 'claude-opus-4-6');
  assert.equal(bundle.memoryPreamble, null);
  assert.equal(bundle.layeredContext, null);
  assert.equal(bundle.skillsText, null);
  assert.equal(bundle.spec, null);
  assert.equal(bundle.targetUrl, null);
});

test('buildRunContextBundle records the recorded preamble texts and redacts the target URL', () => {
  const bundle = buildRunContextBundle({
    runId: 'run_deadbeef',
    systemPrompt: 'BASE',
    memoryPreamble: 'remember X',
    layeredContext: 'project prefers Y',
    skillsText: 'skill: click through onboarding',
    model: 'claude-opus-4-6',
    maxTurns: 50,
    maxBudgetUsd: 2.5,
    targetUrl: 'https://user:hunter2@app.example.com/dashboard',
  });
  assert.equal(bundle.memoryPreamble, 'remember X');
  assert.equal(bundle.layeredContext, 'project prefers Y');
  assert.equal(bundle.skillsText, 'skill: click through onboarding');
  assert.equal(bundle.targetUrl, 'https://app.example.com/dashboard');
  assert.ok(!JSON.stringify(bundle).includes('hunter2'));
  assert.ok(!JSON.stringify(bundle).includes('user:'));
});

test('buildRunContextBundle hashes the referenced spec YAML and never inlines its content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bhm-spec-'));
  const specPath = path.join(dir, 'spec.yaml');
  const specYaml = 'name: my-app\ntarget:\n  type: web\n  url: https://example.com\n';
  fs.writeFileSync(specPath, specYaml, 'utf-8');
  try {
    const bundle = buildRunContextBundle({
      runId: 'run_11111111',
      systemPrompt: 'BASE',
      model: 'claude-opus-4-6',
      maxTurns: 200,
      maxBudgetUsd: 5,
      specPath,
    });
    assert.ok(bundle.spec);
    assert.equal(bundle.spec?.path, specPath);
    assert.equal(bundle.spec?.sha256, createHash('sha256').update(specYaml, 'utf-8').digest('hex'));
    assert.ok(!JSON.stringify(bundle).includes('my-app'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRunContextBundle writes run-context.json to the output directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bhm-write-'));
  try {
    const bundle: RunContextBundle = {
      runId: 'run_22222222',
      createdAt: new Date().toISOString(),
      model: 'claude-opus-4-6',
      maxTurns: 200,
      maxBudgetUsd: 5,
      systemPromptSha256: 'deadbeef',
      memoryPreamble: null,
      layeredContext: null,
      skillsText: null,
      spec: null,
      targetUrl: null,
    };
    writeRunContextBundle(dir, bundle);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'run-context.json'), 'utf-8'));
    assert.equal(written.runId, 'run_22222222');
    assert.equal(written.systemPromptSha256, 'deadbeef');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRunContextBundle never throws, even when the output path is unwritable', () => {
  // Create a file where writeRunContextBundle expects a directory, so
  // fs.mkdirSync(outputDir, { recursive: true }) fails — this must be
  // swallowed, not thrown, per the "writing the bundle must never fail
  // the run" requirement.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bhm-unwritable-'));
  const blockingFile = path.join(dir, 'blocked');
  fs.writeFileSync(blockingFile, 'not a directory', 'utf-8');
  try {
    const bundle: RunContextBundle = {
      runId: 'run_33333333',
      createdAt: new Date().toISOString(),
      model: 'claude-opus-4-6',
      maxTurns: 200,
      maxBudgetUsd: 5,
      systemPromptSha256: 'deadbeef',
      memoryPreamble: null,
      layeredContext: null,
      skillsText: null,
      spec: null,
      targetUrl: null,
    };
    assert.doesNotThrow(() => writeRunContextBundle(path.join(blockingFile, 'subdir'), bundle));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('running the prompt-assembly path twice with a recorded bundle reproduces the same systemPromptSha256 (--with-context)', () => {
  // Simulates the acceptance criterion end to end without needing a live
  // browser/API run: assemble the prompt once "live", record the bundle,
  // then re-assemble using only the recorded texts (as `specify verify
  // --with-context` does via SdkRunnerOptions.contextOverride) and confirm
  // the resulting systemPrompt hashes match byte-for-byte.
  const basePrompt = 'You are Specify. Verify the spec.';
  const liveLayered = 'Project preference: prefer keyboard nav.';
  const liveSkills = 'Skill: dismiss the cookie banner first.';
  const liveMemory = 'Known flake: the toast auto-dismisses after 2s.';

  // First run: live injection.
  const firstSystemPrompt = composeSystemPrompt(basePrompt, {
    layeredContext: liveLayered,
    skillsText: liveSkills,
    memoryPreamble: liveMemory,
  });
  const firstBundle = buildRunContextBundle({
    runId: 'run_first01',
    systemPrompt: firstSystemPrompt,
    memoryPreamble: liveMemory,
    layeredContext: liveLayered,
    skillsText: liveSkills,
    model: 'claude-opus-4-6',
    maxTurns: 200,
    maxBudgetUsd: 5,
  });

  // Second run: as if the live state had since drifted (memory/skills would
  // now render differently), but --with-context forces the recorded texts.
  const driftedLayered = 'Project preference: prefer mouse clicks now.';
  const secondSystemPrompt = composeSystemPrompt(basePrompt, {
    // contextOverride wins over the (drifted) live values.
    layeredContext: firstBundle.layeredContext ?? driftedLayered,
    skillsText: firstBundle.skillsText ?? undefined,
    memoryPreamble: firstBundle.memoryPreamble ?? undefined,
  });
  const secondBundle = buildRunContextBundle({
    runId: 'run_second1',
    systemPrompt: secondSystemPrompt,
    memoryPreamble: firstBundle.memoryPreamble ?? undefined,
    layeredContext: firstBundle.layeredContext ?? undefined,
    skillsText: firstBundle.skillsText ?? undefined,
    model: 'claude-opus-4-6',
    maxTurns: 200,
    maxBudgetUsd: 5,
  });

  assert.equal(secondSystemPrompt, firstSystemPrompt);
  assert.equal(secondBundle.systemPromptSha256, firstBundle.systemPromptSha256);
});
