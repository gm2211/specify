import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BehaviorResult, Spec, VerificationReport } from '../../spec/types.js';
import { loadSpec } from '../../spec/parser.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { runPlaywright, type PlaywrightTestResult } from '../../adapters/playwright.js';

export interface ScriptedVerifyOptions {
  spec: string;
  output?: string;
  timeoutMs?: number;
}

type ScriptedReport = VerificationReport & {
  suitePass: boolean;
  complete: boolean;
};

function testEvidence(test: PlaywrightTestResult): BehaviorResult['evidence'] {
  return [
    {
      type: 'text',
      label: 'scripted-replay',
      content:
        test.status === 'failed'
          ? `generated test failed: ${test.error ?? '(no error message captured)'}`
          : test.status === 'skipped'
            ? 'generated test was skipped'
            : 'generated test passed',
    },
  ];
}

function fail(message: string, reason: string, exitCode: number): number {
  process.stderr.write(`Scripted verification failed: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: 'scripted_error', reason, message }) + '\n');
  return exitCode;
}

/** Run the caller's existing Playwright suite and write a behavior-ID report. */
export async function scriptedVerify(
  options: ScriptedVerifyOptions,
  _ctx: CliContext,
): Promise<number> {
  let spec: Spec;
  const specPath = path.resolve(options.spec);
  try {
    spec = loadSpec(specPath);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      'invalid_spec',
      ExitCode.PARSE_ERROR,
    );
  }

  const outputDir = path.resolve(options.output ?? '.specify/verify');
  const run = await runPlaywright({ cwd: outputDir, timeoutMs: options.timeoutMs });
  if (!run.ok) {
    const code =
      run.reason === 'no_tests'
        ? ExitCode.ALL_UNTESTED
        : run.reason === 'timeout'
          ? ExitCode.TIMEOUT
          : ExitCode.BROWSER_ERROR;
    return fail(
      run.reason === 'no_tests' ? 'no generated tests found in output dir' : run.message,
      run.reason,
      code,
    );
  }

  const behaviorMap = new Map<string, { description: string }>();
  for (const area of spec.areas)
    for (const behavior of area.behaviors) {
      behaviorMap.set(`${area.id}/${behavior.id}`, { description: behavior.description });
    }

  const grouped = new Map<string, PlaywrightTestResult[]>();
  for (const test of run.tests) {
    if (!test.behaviorId || !behaviorMap.has(test.behaviorId)) {
      return fail(
        `generated test title does not identify a known spec behavior: ${test.title}`,
        'unknown_behavior_id',
        ExitCode.PARSE_ERROR,
      );
    }
    const group = grouped.get(test.behaviorId) ?? [];
    group.push(test);
    grouped.set(test.behaviorId, group);
  }

  const results: BehaviorResult[] = [];
  for (const [id, behavior] of behaviorMap) {
    const tests = grouped.get(id) ?? [];
    if (tests.length === 0) {
      results.push({
        id,
        description: behavior.description,
        status: 'skipped',
        method: 'scripted-replay',
        rationale: 'untested: no generated test matched this behavior id',
      });
      continue;
    }
    // A failure wins over any passing or skipped duplicate. Otherwise a skip
    // remains skipped so a partial/multiplatform run cannot look like a pass.
    const representative =
      tests.find((test) => test.status === 'failed') ??
      tests.find((test) => test.status === 'skipped') ??
      tests[0];
    results.push({
      id,
      description: behavior.description,
      status: representative.status,
      method: 'scripted-replay',
      evidence: testEvidence(representative),
    });
  }

  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const matched = grouped.size;
  const suitePass =
    matched > 0 && failed === 0 && !run.tests.some((test) => test.status === 'skipped');
  const complete = skipped === 0;
  const report: ScriptedReport = {
    spec: { name: spec.name, version: spec.version },
    timestamp: new Date().toISOString(),
    pass: suitePass && complete,
    suitePass,
    complete,
    summary: { total: results.length, passed, failed, skipped },
    results,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'verify-result.json'),
    JSON.stringify({ structuredOutput: report }, null, 2) + '\n',
  );
  if (!_ctx.quiet) {
    process.stderr.write(
      `Scripted verification complete: ${passed} passed, ${failed} failed, ${skipped} untested/skipped` +
        ` (suite ${suitePass ? 'passed' : 'incomplete/failed'}, contract ${complete ? 'complete' : 'incomplete'})\n`,
    );
  }
  process.stdout.write(
    JSON.stringify({
      outputDir,
      pass: report.pass,
      suitePass,
      complete,
      structuredOutput: report,
    }) + '\n',
  );

  // Preserve partial-suite use cases: a selected, passing replay is a successful
  // invocation, while the report makes incomplete contract coverage explicit.
  return failed > 0
    ? ExitCode.ASSERTION_FAILURE
    : suitePass
      ? ExitCode.SUCCESS
      : passed === 0
        ? ExitCode.ALL_UNTESTED
        : ExitCode.BROWSER_ERROR;
}
