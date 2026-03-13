/**
 * src/cli/commands/spec-import.ts — Import e2e tests as spec items
 *
 * Runs the test analyzer and produces structured output:
 * analyses, a suggested partial spec from deterministic parts,
 * and raw test sources for LLM callers to do deeper analysis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { analyzeTestFile, analyzeTestDirectory, detectFramework } from '../../e2e/test-analyzer.js';
import type { TestFileAnalysis, TestFramework } from '../../e2e/types.js';
import type { Spec, PageSpec, ScenarioSpec, ScenarioStep } from '../../spec/types.js';
import { specToYaml } from '../../spec/parser.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { formatOutput } from '../output.js';

export interface SpecImportOptions {
  from: string;
  framework?: string;
  output?: string;
}

export async function specImport(options: SpecImportOptions, ctx: CliContext): Promise<number> {
  const fromPath = path.resolve(options.from);
  const framework = (options.framework as TestFramework) ?? undefined;

  if (!fs.existsSync(fromPath)) {
    process.stderr.write(`Path not found: ${fromPath}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Analyze
  let analyses: TestFileAnalysis[];
  const stat = fs.statSync(fromPath);
  if (stat.isDirectory()) {
    analyses = analyzeTestDirectory(fromPath, framework);
  } else {
    analyses = [analyzeTestFile(fromPath, framework)];
  }

  if (analyses.length === 0) {
    process.stderr.write('No test files found.\n');
    return ExitCode.PARSE_ERROR;
  }

  // Build suggested partial spec from deterministic parts
  const suggestedSpec = buildPartialSpec(analyses);

  // Collect raw sources for LLM context
  const testSources: Record<string, string> = {};
  for (const analysis of analyses) {
    try {
      testSources[analysis.filePath] = fs.readFileSync(analysis.filePath, 'utf-8');
    } catch { /* skip */ }
  }

  const result = {
    analyses,
    suggestedSpec,
    testSources,
  };

  // Output
  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    if (!ctx.quiet) process.stdout.write(formatOutput(result, ctx) + '\n');
  } else {
    // Human-readable summary
    if (!ctx.quiet) {
      process.stderr.write(`\nAnalyzed ${analyses.length} test file(s)\n`);
      for (const a of analyses) {
        const testCount = a.suites.reduce((n, s) => n + s.tests.length, 0) + a.tests.length;
        process.stderr.write(`  ${path.relative(process.cwd(), a.filePath)} (${a.framework}) — ${testCount} test(s)\n`);
      }
      process.stderr.write(`\nSuggested spec: ${suggestedSpec.pages?.length ?? 0} page(s), ${suggestedSpec.flows?.length ?? 0} flow(s)\n`);
    }
    // Always output JSON to stdout for piping
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  // Write spec file if requested
  if (options.output) {
    const yaml = specToYaml(suggestedSpec);
    const outPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, yaml, 'utf-8');
    if (!ctx.quiet) process.stderr.write(`Spec written to: ${outPath}\n`);
  }

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Partial spec builder
// ---------------------------------------------------------------------------

function buildPartialSpec(analyses: TestFileAnalysis[]): Spec {
  const pages: PageSpec[] = [];
  const seenPaths = new Set<string>();

  for (const analysis of analyses) {
    const allTests = [
      ...analysis.suites.flatMap(s => s.tests),
      ...analysis.tests,
    ];

    for (const test of allTests) {
      for (const nav of test.navigations) {
        const pagePath = extractPath(nav);
        if (seenPaths.has(pagePath)) continue;
        seenPaths.add(pagePath);

        const id = pathToId(pagePath);
        const scenarios: ScenarioSpec[] = [];

        // Build scenario from interactions if any
        if (test.interactions.length > 0) {
          const steps: ScenarioStep[] = [];
          for (const interaction of test.interactions) {
            const step = interactionToStep(interaction);
            if (step) steps.push(step);
          }
          if (steps.length > 0) {
            scenarios.push({
              id: slugify(test.name),
              description: test.name,
              steps,
            });
          }
        }

        pages.push({
          id,
          path: pagePath,
          ...(scenarios.length > 0 ? { scenarios } : {}),
        });
      }
    }
  }

  return {
    version: '1.0',
    name: 'Imported from e2e tests',
    description: 'Partial spec generated from existing test files — review and enrich',
    ...(pages.length > 0 ? { pages } : {}),
  };
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? url : '/' + url;
  }
}

function pathToId(p: string): string {
  return p.replace(/^\//, '').replace(/[\/\?&#=.]/g, '-').replace(/-+/g, '-') || 'root';
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function interactionToStep(interaction: { type: string; selector?: string; value?: string }): ScenarioStep | null {
  switch (interaction.type) {
    case 'click':
      return interaction.selector ? { action: 'click', selector: interaction.selector } : null;
    case 'fill':
      return interaction.selector && interaction.value
        ? { action: 'fill', selector: interaction.selector, value: interaction.value }
        : null;
    case 'select':
      return interaction.selector && interaction.value
        ? { action: 'select', selector: interaction.selector, value: interaction.value }
        : null;
    case 'hover':
      return interaction.selector ? { action: 'hover', selector: interaction.selector } : null;
    case 'keypress':
      return interaction.value ? { action: 'keypress', key: interaction.value } : null;
    default:
      return null;
  }
}
