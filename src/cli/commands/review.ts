/**
 * src/cli/commands/review.ts — Open an interactive spec browser in the browser
 *
 * `specify review --spec <path> [--narrative <path>] [--report <path>] [--output <path>] [--no-open]`
 *
 * Generates a self-contained HTML file and opens it in the default browser.
 * The browser shows the human-readable narrative with toggle to computable spec,
 * and overlays validation results from the latest test run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { loadSpec } from '../../spec/parser.js';
import { markdownToNarrative, specNarrativeToDocument } from '../../spec/narrative.js';
import { generateReviewHtml } from '../../review/generator.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import type { GapReport } from '../../validation/types.js';
import type { CliGapReport } from '../../cli-test/types.js';

export interface ReviewOptions {
  spec: string;
  narrative?: string;
  report?: string;
  output?: string;
  noOpen?: boolean;
}

export async function review(options: ReviewOptions, ctx: CliContext): Promise<number> {
  const log = (msg: string) => {
    if (!ctx.quiet) process.stderr.write(msg + '\n');
  };

  // Validate required params
  if (!options.spec) {
    const err = { error: 'missing_parameter', parameter: '--spec', message: 'Spec file path is required' };
    process.stdout.write(JSON.stringify(err) + '\n');
    return ExitCode.PARSE_ERROR;
  }

  // Load spec
  let spec;
  try {
    spec = loadSpec(options.spec);
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Load narrative — prefer embedded spec.narrative, fall back to external markdown file
  const specDir = path.dirname(path.resolve(options.spec));
  let narrative;
  if (spec.narrative && spec.narrative.length > 0 && !options.narrative) {
    narrative = specNarrativeToDocument(spec);
    log(`Loaded narrative from spec`);
  } else {
    const rawNarrativePath = options.narrative
      ?? spec.narrative_path
      ?? path.basename(options.spec).replace(/\.(ya?ml|json)$/, '.narrative.md');
    const resolvedNarrative = path.isAbsolute(rawNarrativePath)
      ? rawNarrativePath
      : path.resolve(specDir, rawNarrativePath);

    if (fs.existsSync(resolvedNarrative)) {
      try {
        const md = fs.readFileSync(resolvedNarrative, 'utf-8');
        narrative = markdownToNarrative(md);
        log(`Loaded narrative: ${resolvedNarrative}`);
      } catch (err) {
        log(`Warning: failed to parse narrative ${resolvedNarrative}: ${(err as Error).message}`);
      }
    } else {
      log(`No narrative file found (tried: ${resolvedNarrative}), building from spec structure`);
    }
  }

  // Load report(s) if specified
  let webReport: GapReport | undefined;
  let cliReport: CliGapReport | undefined;

  if (options.report) {
    try {
      const reportPath = path.resolve(options.report);
      const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));

      // Detect report type by structure
      if (reportData.pages) {
        webReport = reportData as GapReport;
        log(`Loaded web report: ${options.report}`);
      } else if (reportData.commands) {
        cliReport = reportData as CliGapReport;
        log(`Loaded CLI report: ${options.report}`);
      } else {
        log(`Warning: unrecognized report format in ${options.report}`);
      }
    } catch (err) {
      log(`Warning: failed to load report ${options.report}: ${(err as Error).message}`);
    }
  }

  // Auto-discover reports in common locations
  if (!options.report) {
    const specDir = path.dirname(path.resolve(options.spec));
    for (const candidate of ['gap-report.json', 'cli-report.json']) {
      const p = path.join(specDir, candidate);
      if (fs.existsSync(p)) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
          if (candidate === 'gap-report.json' && data.pages) {
            webReport = data as GapReport;
            log(`Auto-discovered web report: ${candidate}`);
          } else if (candidate === 'cli-report.json' && data.commands) {
            cliReport = data as CliGapReport;
            log(`Auto-discovered CLI report: ${candidate}`);
          }
        } catch { /* skip */ }
      }
    }
  }

  // Generate HTML
  const html = generateReviewHtml({ spec, narrative, webReport, cliReport });

  // Determine output path
  const outputPath = options.output
    ?? options.spec.replace(/\.(ya?ml|json)$/, '.review.html');
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, html, 'utf-8');

  log(`Review page written to: ${resolvedOutput}`);

  // Auto-open in browser unless --no-open
  if (!options.noOpen) {
    const platform = process.platform;
    const openCmd = platform === 'darwin' ? 'open'
      : platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const openArgs = platform === 'win32'
      ? ['/c', 'start', '', resolvedOutput]
      : [resolvedOutput];
    execFile(openCmd, openArgs, (err) => {
      if (err) {
        log(`Could not auto-open browser: ${err.message}`);
        log(`Open manually: ${resolvedOutput}`);
      }
    });
    log(`Opening in browser...`);
  }

  // Structured output
  const result = {
    output: resolvedOutput,
    spec: spec.name,
    hasNarrative: !!narrative,
    hasWebReport: !!webReport,
    hasCliReport: !!cliReport,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  return ExitCode.SUCCESS;
}
