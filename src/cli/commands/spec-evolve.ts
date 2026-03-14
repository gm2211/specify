/**
 * src/cli/commands/spec-evolve.ts — Evolve a spec based on PR, gap report, or interactive analysis
 *
 * Modes (first match wins):
 *   --pr <number|url>       Analyze a PR diff and suggest spec changes
 *   --report <path>         Analyze a gap report JSON and suggest/apply refinements
 *   --apply                 Interactive mode — walk user through fixing gaps (uses gap-analyzer)
 *   (none of the above)     Analyze spec gaps, output structured suggestions as JSON
 *
 * Additional flags:
 *   --output <path>         Write the refined spec to a file (report & apply modes)
 *   --url <url>             Crawl URL for context (apply mode only)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { loadSpec, parseSpec, specToYaml } from '../../spec/parser.js';
import {
  analyzePr,
  analyzeInteractive,
  summarizeSpec,
  type EvolveResult,
  type PrContext,
  type ChangedFile,
} from '../../spec/evolve.js';
import { analyzeGaps, applyRefinements, suggestionsToMarkdown } from '../../spec/refiner.js';
import type { Spec } from '../../spec/types.js';
import type { GapReport } from '../../validation/types.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';
import { c } from '../colors.js';

export interface SpecEvolveOptions {
  spec: string;
  pr?: string;
  repo?: string;
  report?: string;
  apply?: boolean;
  output?: string;
  url?: string;
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
  } else if (options.report) {
    // Report-based refinement mode (absorbed from spec refine --report)
    return runReportMode(spec, options, ctx);
  } else if (options.apply) {
    // Interactive apply mode (absorbed from spec refine interactive)
    return runApplyMode(spec, options, ctx);
  } else {
    // Default: analyze spec gaps, output structured suggestions
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
// Report-based refinement mode (from spec refine --report)
// ---------------------------------------------------------------------------

function runReportMode(
  spec: Spec,
  options: SpecEvolveOptions,
  ctx: CliContext,
): number {
  // Load report
  let report: GapReport;
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(options.report!), 'utf-8')) as GapReport;
  } catch (err) {
    process.stderr.write(`Failed to load report: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Analyze gaps
  const suggestions = analyzeGaps(spec, report);

  if (suggestions.length === 0) {
    if (ctx.outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ suggestions: [], message: 'No refinements needed' }) + '\n');
    } else if (!ctx.quiet) {
      process.stdout.write('No refinement suggestions — spec is well-aligned with capture.\n');
    }
    return ExitCode.SUCCESS;
  }

  // Apply refinements
  const refined = applyRefinements(spec, suggestions);

  // Output suggestions
  if (ctx.outputFormat === 'json') {
    process.stdout.write(formatOutput({ suggestions, refined }, ctx) + '\n');
  } else if (!ctx.quiet) {
    process.stdout.write(suggestionsToMarkdown(suggestions) + '\n');
  }

  // Write refined spec if --output specified
  if (options.output) {
    const outputPath = path.resolve(options.output);
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, specToYaml(refined), 'utf-8');
    if (!ctx.quiet) {
      process.stderr.write(`Refined spec written to: ${outputPath}\n`);
    }
  }

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Interactive apply mode (from spec refine interactive)
// ---------------------------------------------------------------------------

async function runApplyMode(
  spec: Spec,
  options: SpecEvolveOptions,
  ctx: CliContext,
): Promise<number> {
  // Optionally crawl the URL for context
  let discoveredPages;
  if (options.url) {
    process.stderr.write(`\n  Crawling ${options.url} for context...\n`);
    try {
      const { discoverPages } = await import('../interactive/crawler.js');
      discoveredPages = await discoverPages(options.url, { maxPages: 20 });
      process.stderr.write(`  Found ${discoveredPages.length} page(s)\n`);
    } catch (err) {
      process.stderr.write(`  Could not crawl URL: ${(err as Error).message}\n`);
    }
  }

  // Set up readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  const ask = (question: string, defaultVal?: string): Promise<string> =>
    new Promise((resolve) => {
      const suffix = defaultVal ? ` [${defaultVal}]` : '';
      rl.question(`  ${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultVal || '');
      });
    });

  const confirm = (question: string, defaultYes = true): Promise<boolean> =>
    new Promise((resolve) => {
      const hint = defaultYes ? '[Y/n]' : '[y/N]';
      rl.question(`  ${question} ${hint} `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === '') resolve(defaultYes);
        else resolve(a === 'y' || a === 'yes');
      });
    });

  const choose = (question: string, choices: string[]): Promise<number> =>
    new Promise((resolve) => {
      console.error(`\n  ${question}`);
      for (let i = 0; i < choices.length; i++) {
        console.error(`    ${i + 1}. ${choices[i]}`);
      }
      rl.question('  Choice: ', (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        resolve(idx >= 0 && idx < choices.length ? idx : 0);
      });
    });

  try {
    const { analyzeSpecGaps } = await import('../../spec/gap-analyzer.js');
    const gaps = analyzeSpecGaps(spec, discoveredPages);

    console.error('');
    console.error('  Spec Evolution — Interactive Apply Mode');
    console.error('  ───────────────────────────────────────');
    console.error('');
    console.error(`  Spec: ${spec.name}`);
    console.error(`  Pages: ${spec.pages?.length ?? 0}`);
    console.error(`  Flows: ${spec.flows?.length ?? 0}`);
    if (discoveredPages) {
      console.error(`  Discovered pages: ${discoveredPages.length}`);
    }

    if (gaps.length === 0) {
      console.error('');
      console.error('  Spec looks comprehensive — no obvious gaps found.');
    } else {
      console.error(`  Found ${gaps.length} area(s) to improve.`);
      console.error('');

      for (const gap of gaps) {
        console.error(`  ── ${gap.category} ──`);
        console.error(`  ${gap.description}`);
        console.error('');

        const shouldFix = await confirm(gap.question, true);
        if (shouldFix) {
          await gap.apply(spec, { ask, confirm, choose });
        }
        console.error('');
      }
    }

    // Output the refined spec
    const yaml = specToYaml(spec);

    if (ctx.outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ spec }) + '\n');
    } else {
      process.stdout.write(yaml);
    }

    // Save
    const outputPath = options.output ?? options.spec;
    const shouldSave = await confirm(`Save refined spec to ${outputPath}?`, true);
    if (shouldSave) {
      const resolved = path.resolve(outputPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, yaml, 'utf-8');
      process.stderr.write(`  Saved to: ${resolved}\n`);
    }

    rl.close();
    return ExitCode.SUCCESS;
  } catch (err) {
    rl.close();
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      return ExitCode.SUCCESS;
    }
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.PARSE_ERROR;
  }
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
