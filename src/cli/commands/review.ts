/**
 * src/cli/commands/review.ts — Open an interactive spec browser in the browser
 *
 * `specify review --spec <path> [--narrative <path>] [--report <path>] [--agent-report <path>] [--output <path>] [--no-open]`
 *
 * Generates a self-contained HTML file and opens it in the default browser.
 * The browser shows the human-readable narrative with toggle to computable spec,
 * and overlays validation results from the latest test run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { loadSpec } from '../../spec/parser.js';
import { markdownToNarrative } from '../../spec/narrative.js';
import { generateReviewHtml } from '../../review/generator.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import type { AgentVerifyResult } from '../../review/generator.js';

export interface ReviewOptions {
  spec: string;
  narrative?: string;
  report?: string;
  agentReport?: string;
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

  // Load narrative from external markdown file
  const specDir = path.dirname(path.resolve(options.spec));
  let narrative;
  const rawNarrativePath = options.narrative
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

  // Load agent report if specified
  let agentResult: AgentVerifyResult | undefined;
  if (options.agentReport) {
    try {
      const agentPath = path.resolve(options.agentReport);
      const agentData = JSON.parse(fs.readFileSync(agentPath, 'utf-8'));
      if (agentData.structuredOutput) {
        agentResult = agentData.structuredOutput as AgentVerifyResult;
      } else if (agentData.pass !== undefined && agentData.results) {
        agentResult = agentData as AgentVerifyResult;
      }
      if (agentResult) log(`Loaded agent report: ${options.agentReport}`);
    } catch (err) {
      log(`Warning: failed to load agent report ${options.agentReport}: ${(err as Error).message}`);
    }
  }

  // Auto-discover agent results in .specify/verify/
  if (!agentResult && !options.agentReport) {
    const specDir = path.dirname(path.resolve(options.spec));
    const verifyDir = path.join(specDir, '.specify', 'verify');
    if (fs.existsSync(verifyDir)) {
      // Look for the most recent agent result JSON
      try {
        const files = fs.readdirSync(verifyDir)
          .filter(f => f.endsWith('.json'))
          .map(f => ({ name: f, path: path.join(verifyDir, f), mtime: fs.statSync(path.join(verifyDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        for (const file of files) {
          try {
            const data = JSON.parse(fs.readFileSync(file.path, 'utf-8'));
            if (data.structuredOutput && data.structuredOutput.results) {
              agentResult = data.structuredOutput as AgentVerifyResult;
              log(`Auto-discovered agent report: ${file.name}`);
              break;
            } else if (data.pass !== undefined && Array.isArray(data.results)) {
              agentResult = data as AgentVerifyResult;
              log(`Auto-discovered agent report: ${file.name}`);
              break;
            }
          } catch { /* skip individual files */ }
        }
      } catch { /* skip if directory can't be read */ }
    }
  }

  // Generate HTML
  const html = generateReviewHtml({ spec, narrative, agentResult });

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
    hasAgentReport: !!agentResult,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  return ExitCode.SUCCESS;
}
