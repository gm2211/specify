/**
 * src/cli/commands/spec-evolve.ts — Evolve a spec based on PR or interactive analysis
 *
 * Two modes:
 *   --pr <number|url>   Analyze a PR diff and suggest spec changes
 *   (no --pr)            Interactive mode — analyze spec gaps for LLM agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { loadSpec, parseSpec } from '../../spec/parser.js';
import {
  analyzePr,
  analyzeInteractive,
  summarizeSpec,
  type EvolveResult,
  type PrContext,
  type ChangedFile,
} from '../../spec/evolve.js';
import type { Spec } from '../../spec/types.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';
import { c } from '../colors.js';

export interface SpecEvolveOptions {
  spec: string;
  pr?: string;
  repo?: string;
}

export async function specEvolve(options: SpecEvolveOptions, ctx: CliContext): Promise<number> {
  // Load spec
  let spec: Spec;
  try {
    if (options.spec === '-') {
      const input = await readStdin();
      spec = parseSpec(input);
    } else {
      spec = loadSpec(options.spec);
    }
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const specSummary = summarizeSpec(spec);

  if (options.pr) {
    // PR mode
    return await runPrMode(spec, specSummary, options, ctx);
  } else {
    // Interactive mode
    return runInteractiveMode(spec, specSummary, ctx);
  }
}

// ---------------------------------------------------------------------------
// PR mode
// ---------------------------------------------------------------------------

async function runPrMode(
  spec: Spec,
  specSummary: ReturnType<typeof summarizeSpec>,
  options: SpecEvolveOptions,
  ctx: CliContext,
): Promise<number> {
  const prRef = options.pr!;

  // Fetch PR data using gh CLI
  let prContext: PrContext;
  try {
    prContext = fetchPrData(prRef, options.repo);
  } catch (err) {
    process.stderr.write(`Failed to fetch PR data: ${(err as Error).message}\n`);
    process.stderr.write(`Make sure the 'gh' CLI is installed and authenticated.\n`);
    return ExitCode.NETWORK_ERROR;
  }

  if (!ctx.quiet) {
    process.stderr.write(`\nAnalyzing PR #${prContext.pr_number}: ${prContext.title}\n`);
    process.stderr.write(`  ${prContext.changed_files.length} files changed (+${prContext.additions} -${prContext.deletions})\n\n`);
  }

  const suggestions = analyzePr(spec, prContext);

  const result: EvolveResult = {
    mode: 'pr',
    spec_summary: specSummary,
    suggestions,
    pr_context: prContext,
  };

  outputResult(result, ctx);

  if (!ctx.quiet) {
    process.stderr.write(`\n${suggestions.length} suggestion(s)\n`);
    for (const s of suggestions) {
      const icon = s.priority === 'high' ? '!' : s.priority === 'medium' ? '~' : '.';
      process.stderr.write(`  [${icon}] ${s.description}\n`);
    }
  }

  return suggestions.some(s => s.priority === 'high')
    ? ExitCode.ASSERTION_FAILURE
    : ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Interactive mode (for LLM agent with askUser)
// ---------------------------------------------------------------------------

function runInteractiveMode(
  spec: Spec,
  specSummary: ReturnType<typeof summarizeSpec>,
  ctx: CliContext,
): number {
  if (!ctx.quiet) {
    process.stderr.write(`\n${c.boldCyan('Analyzing spec:')} ${c.bold(spec.name)}\n`);
    process.stderr.write(`  ${c.dim('Pages:')} ${specSummary.page_count}  ${c.dim('Flows:')} ${specSummary.flow_count}  ${c.dim('Scenarios:')} ${specSummary.scenario_count}\n`);
    if (specSummary.cli_command_count > 0) {
      process.stderr.write(`  ${c.dim('CLI commands:')} ${specSummary.cli_command_count}  ${c.dim('CLI scenarios:')} ${specSummary.cli_scenario_count}\n`);
    }
    process.stderr.write('\n');
  }

  const suggestions = analyzeInteractive(spec);

  const result: EvolveResult = {
    mode: 'interactive',
    spec_summary: specSummary,
    suggestions,
  };

  outputResult(result, ctx);

  if (!ctx.quiet) {
    process.stderr.write(`\n${c.bold(String(suggestions.length))} suggestion(s) for spec evolution\n`);

    // Group by priority
    const high = suggestions.filter(s => s.priority === 'high');
    const medium = suggestions.filter(s => s.priority === 'medium');
    const low = suggestions.filter(s => s.priority === 'low');

    if (high.length > 0) {
      process.stderr.write(`\n  ${c.boldRed('High priority:')}\n`);
      for (const s of high) process.stderr.write(`    ${c.red('!')} ${s.description}\n`);
    }
    if (medium.length > 0) {
      process.stderr.write(`\n  ${c.boldYellow('Medium priority:')}\n`);
      for (const s of medium) process.stderr.write(`    ${c.yellow('~')} ${s.description}\n`);
    }
    if (low.length > 0) {
      process.stderr.write(`\n  ${c.dim('Low priority:')}\n`);
      for (const s of low) process.stderr.write(`    ${c.dim('·')} ${s.description}\n`);
    }
    process.stderr.write('\n');
  }

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function outputResult(result: EvolveResult, ctx: CliContext): void {
  if (ctx.quiet) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(formatOutput(result, ctx) + '\n');
  } else {
    // Always output structured JSON to stdout (agents parse it)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// GitHub PR data fetching
// ---------------------------------------------------------------------------

function fetchPrData(prRef: string, repo?: string): PrContext {
  // Extract PR number from URL or use directly
  let prNumber: string;
  const urlMatch = prRef.match(/\/pull\/(\d+)/);
  if (urlMatch) {
    prNumber = urlMatch[1];
    // Extract repo from URL if not provided
    if (!repo) {
      const repoMatch = prRef.match(/github\.com\/([^/]+\/[^/]+)/);
      if (repoMatch) repo = repoMatch[1];
    }
  } else {
    prNumber = prRef;
  }

  const repoFlag = repo ? `-R ${repo}` : '';

  // Fetch PR metadata
  const prJson = execSync(
    `gh pr view ${prNumber} ${repoFlag} --json number,title,body,additions,deletions,files`,
    { encoding: 'utf-8', timeout: 30_000 },
  );
  const pr = JSON.parse(prJson);

  // Fetch diff for patch content
  let diffText = '';
  try {
    diffText = execSync(
      `gh pr diff ${prNumber} ${repoFlag}`,
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    // Diff fetch failed — proceed without patches
  }

  // Parse diff into per-file patches
  const filePatchMap = parseDiffToFiles(diffText);

  const changedFiles: ChangedFile[] = (pr.files ?? []).map((f: { path: string; additions: number; deletions: number }) => {
    let status: ChangedFile['status'] = 'modified';
    if (f.additions > 0 && f.deletions === 0) status = 'added';
    if (f.additions === 0 && f.deletions > 0) status = 'removed';

    return {
      filename: f.path,
      status,
      additions: f.additions,
      deletions: f.deletions,
      patch: filePatchMap.get(f.path),
    };
  });

  return {
    pr_number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? '',
    changed_files: changedFiles,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
  };
}

/** Parse unified diff output into a map of filename → patch content. */
function parseDiffToFiles(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!diff) return result;

  const parts = diff.split(/^diff --git /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    // Extract filename from "a/path b/path" line
    const headerMatch = part.match(/^a\/(.+?)\s+b\/(.+)/m);
    if (headerMatch) {
      const filename = headerMatch[2];
      result.set(filename, part);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
