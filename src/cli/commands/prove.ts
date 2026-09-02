/**
 * src/cli/commands/prove.ts — `specify prove`
 *
 * Turns a completed `specify verify` output directory into one
 * self-contained proof.html — see src/report/proof-html.ts (renderer) and
 * src/report/proof-loader.ts (fs + evidence-matching layer) for the actual
 * work. This command is just argument parsing, structured error reporting,
 * and wiring the two together.
 *
 * A failing verify run still produces a proof and exits 0 — prove documents
 * the verdict the run reached (pass or fail), it does not adopt one itself.
 * Only prove's own preconditions (missing input, unreadable spec, malformed
 * verify-result.json, …) produce a non-zero exit.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { c } from '../colors.js';
import { loadSpec } from '../../spec/parser.js';
import { loadProofInput, readGeneratorVersion, DEFAULT_SCREENSHOT_BYTE_CAP } from '../../report/proof-loader.js';
import { renderProofHtml } from '../../report/proof-html.js';

export interface ProveOptions {
  spec: string;
  input?: string;
  output?: string;
  maxScreenshotBytes?: string;
}

export function parseScreenshotCap(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SCREENSHOT_BYTE_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCREENSHOT_BYTE_CAP;
  return n;
}

export function resolveProvePaths(input: string | undefined, output: string | undefined): { inputDir: string; outputPath: string } {
  const inputDir = path.resolve(input ?? '.specify/verify');
  const outputPath = output ? path.resolve(output) : path.join(inputDir, 'proof.html');
  return { inputDir, outputPath };
}

function formatMiB(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const mib = bytes / (1024 * 1024);
  if (mib < 0.1) return `${Math.round(bytes / 1024)} KiB`;
  return `${mib.toFixed(1)} MiB`;
}

function emitError(error: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(error) + '\n');
}

export async function prove(options: ProveOptions, ctx: CliContext): Promise<number> {
  // Order is load-bearing: --input/--output shape, then input existence,
  // then verify-result.json presence, THEN --spec — a missing --input
  // directory is diagnosed before a missing --spec, since the input
  // directory is almost always the more actionable problem.
  if (options.input === '') {
    emitError({ error: 'invalid_parameter', parameter: '--input', hint: '--input requires a path' });
    if (!ctx.quiet) process.stderr.write('Error: --input requires a path\n');
    return ExitCode.PARSE_ERROR;
  }
  if (options.output === '') {
    emitError({ error: 'invalid_parameter', parameter: '--output', hint: '--output requires a path' });
    if (!ctx.quiet) process.stderr.write('Error: --output requires a path\n');
    return ExitCode.PARSE_ERROR;
  }

  const { inputDir, outputPath } = resolveProvePaths(options.input, options.output);

  if (!fs.existsSync(inputDir)) {
    emitError({
      error: 'input_not_found',
      parameter: '--input',
      path: inputDir,
      hint: 'Run "specify verify" first, or pass --input <verify output dir>',
    });
    if (!ctx.quiet) process.stderr.write(`Error: input directory not found: ${inputDir}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const verifyResultPath = path.join(inputDir, 'verify-result.json');
  if (!fs.existsSync(verifyResultPath)) {
    emitError({
      error: 'verify_result_not_found',
      path: verifyResultPath,
      hint: 'Expected verify-result.json in the --input directory. Run "specify verify --output <dir>" first.',
    });
    if (!ctx.quiet) process.stderr.write(`Error: verify-result.json not found under ${inputDir}\n`);
    return ExitCode.PARSE_ERROR;
  }

  if (!options.spec) {
    emitError({ error: 'missing_parameter', parameter: '--spec', hint: 'Provide a spec file or run from a directory containing one' });
    if (!ctx.quiet) process.stderr.write('Error: --spec is required\n');
    return ExitCode.PARSE_ERROR;
  }

  let spec;
  try {
    spec = loadSpec(options.spec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError({ error: 'invalid_spec', message });
    if (!ctx.quiet) process.stderr.write(`Error: failed to load spec: ${message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  let proofInput;
  try {
    proofInput = loadProofInput({
      spec,
      specPath: path.resolve(options.spec),
      inputDir,
      outputPath,
      generatorVersion: readGeneratorVersion(),
      maxScreenshotBytes: parseScreenshotCap(options.maxScreenshotBytes),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError({ error: 'invalid_verify_result', message });
    if (!ctx.quiet) process.stderr.write(`Error: failed to load verify result: ${message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const html = renderProofHtml(proofInput);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf-8');

  const { passed, failed, skipped, untested, total } = proofInput.run.summary;
  let runnerRecordedEvidence = 0;
  let agentReportedEvidence = 0;
  for (const area of proofInput.areas) {
    for (const behavior of area.behaviors) {
      runnerRecordedEvidence += behavior.counts.runnerRecorded;
      agentReportedEvidence += behavior.counts.agentReported;
    }
  }

  const successPayload = {
    output: outputPath,
    spec: proofInput.spec.name,
    target: proofInput.target.type,
    behaviors: total,
    passed,
    failed,
    skipped,
    untested,
    runnerRecordedEvidence,
    agentReportedEvidence,
    screenshotsEmbedded: proofInput.integrity.screenshotsEmbedded,
    screenshotsLinked: proofInput.integrity.screenshotsLinked,
    bytes: proofInput.integrity.screenshotEncodedBytes,
  };

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(JSON.stringify(successPayload) + '\n');
  }

  if (!ctx.quiet) {
    process.stderr.write(`${c.boldGreen('✓ Proof written:')} ${outputPath}\n`);
    process.stderr.write(`  ${total} behaviors · ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
    process.stderr.write(`  Evidence: ${runnerRecordedEvidence} runner-recorded, ${agentReportedEvidence} agent-reported\n`);
    process.stderr.write(
      `  Screenshots: ${proofInput.integrity.screenshotsEmbedded} embedded, ${proofInput.integrity.screenshotsLinked} linked (${formatMiB(proofInput.integrity.screenshotEncodedBytes)} inlined)\n`,
    );
    process.stderr.write(`  ${c.yellow('⚠ proof.html embeds recorded stdout/stderr and screenshots verbatim — review before sharing.')}\n`);
    process.stderr.write(`  $ open ${outputPath}\n`);
  }

  return ExitCode.SUCCESS;
}
