import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { loadSpec, specToYaml } from '../../spec/parser.js';
import type { GapReport } from '../../validation/types.js';
import { analyzeGaps, applyRefinements, suggestionsToMarkdown } from '../../spec/refiner.js';
import { formatOutput } from '../output.js';

export interface SpecRefineOptions {
  spec: string;
  report?: string;
  url?: string;
  output?: string;
}

export async function specRefine(options: SpecRefineOptions, ctx: CliContext): Promise<number> {
  if (!options.spec) {
    process.stderr.write('Error: --spec is required\n');
    return ExitCode.PARSE_ERROR;
  }

  // If no --report, enter interactive gap-analysis mode
  if (!options.report) {
    return interactiveMode(options, ctx);
  }

  // --- Report-based refinement ---

  // Load spec
  let spec;
  try {
    spec = loadSpec(options.spec);
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Load report
  let report: GapReport;
  try {
    report = JSON.parse(fs.readFileSync(path.resolve(options.report), 'utf-8')) as GapReport;
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
// Interactive mode — gap-analysis driven
// ---------------------------------------------------------------------------

async function interactiveMode(options: SpecRefineOptions, ctx: CliContext): Promise<number> {
  // Load spec
  let spec;
  try {
    spec = loadSpec(options.spec);
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }

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
    console.error('  Spec Refinement — Interactive Mode');
    console.error('  ──────────────────────────────────');
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
