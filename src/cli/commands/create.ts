/**
 * src/cli/commands/create.ts — Interactive product spec creation
 *
 * `specify create [--output <path>] [--narrative <path>]`
 *
 * Runs a structured interview that produces both:
 *   1. A computable spec (YAML)
 *   2. A narrative companion document (Markdown)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { runInterview, type PromptHelpers } from '../../spec/interviewer.js';
import { specToYaml } from '../../spec/parser.js';
import { narrativeToMarkdown } from '../../spec/narrative.js';
import { ExitCode } from '../exit-codes.js';
import { c } from '../colors.js';

export interface CreateOptions {
  output?: string;
  narrative?: string;
}

export function deriveNarrativePath(specPath: string): string {
  if (/\.(ya?ml|json)$/i.test(specPath)) {
    return specPath.replace(/\.(ya?ml|json)$/i, '.narrative.md');
  }

  return `${specPath}.narrative.md`;
}

export async function create(options: CreateOptions): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  const prompts: PromptHelpers = {
    ask: (question: string, defaultVal?: string): Promise<string> =>
      new Promise((resolve) => {
        const suffix = defaultVal ? ` ${c.dim(`[${defaultVal}]`)}` : '';
        rl.question(`  ${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultVal || '');
        });
      }),

    confirm: (question: string, defaultYes = true): Promise<boolean> =>
      new Promise((resolve) => {
        const hint = defaultYes ? c.dim('[Y/n]') : c.dim('[y/N]');
        rl.question(`  ${question} ${hint} `, (answer) => {
          const a = answer.trim().toLowerCase();
          if (a === '') resolve(defaultYes);
          else resolve(a === 'y' || a === 'yes');
        });
      }),

    choose: (question: string, choices: string[]): Promise<number> =>
      new Promise((resolve) => {
        process.stderr.write(`\n  ${question}\n`);
        for (let i = 0; i < choices.length; i++) {
          process.stderr.write(`    ${c.cyan(String(i + 1))}. ${choices[i]}\n`);
        }
        rl.question('  Choice: ', (answer) => {
          const idx = parseInt(answer.trim(), 10) - 1;
          resolve(idx >= 0 && idx < choices.length ? idx : 0);
        });
      }),

    say: (message: string) => {
      process.stderr.write(`\n  ${message}\n`);
    },

    section: (title: string) => {
      process.stderr.write(`\n  ${c.boldCyan(title)}\n  ${'─'.repeat(title.length)}\n`);
    },
  };

  try {
    process.stderr.write(`\n  ${c.boldCyan('Specify')} ${c.dim('—')} Product Spec Creator\n`);
    process.stderr.write(`  ${'═'.repeat(35)}\n`);
    process.stderr.write(`\n  ${c.dim('I\'ll ask you about your product and generate both a')}\n`);
    process.stderr.write(`  ${c.dim('computable spec (YAML) and a human-readable narrative (Markdown).')}\n`);

    const { spec, narrative } = await runInterview(prompts);

    // Determine output paths
    const specPath = options.output ?? 'spec.yaml';
    const narrativePath = options.narrative ?? deriveNarrativePath(specPath);

    // Link them
    narrative.specPath = specPath;

    // Serialize
    const yamlContent = specToYaml(spec);
    const mdContent = narrativeToMarkdown(narrative);

    // Preview
    process.stderr.write(`\n  ${c.boldCyan('Preview')}\n  ${'─'.repeat(7)}\n`);
    process.stderr.write(`\n${c.dim('--- spec ---')}\n`);
    // Show first 30 lines of spec
    const specLines = yamlContent.split('\n');
    for (let i = 0; i < Math.min(30, specLines.length); i++) {
      process.stderr.write(`  ${specLines[i]}\n`);
    }
    if (specLines.length > 30) {
      process.stderr.write(`  ${c.dim(`... (${specLines.length - 30} more lines)`)}\n`);
    }
    process.stderr.write(`${c.dim('--- end ---')}\n`);

    // Confirm save
    const shouldSave = await prompts.confirm(`\nSave spec to ${specPath} and narrative to ${narrativePath}?`, true);

    if (shouldSave) {
      // Write spec
      const resolvedSpec = path.resolve(specPath);
      fs.mkdirSync(path.dirname(resolvedSpec), { recursive: true });
      fs.writeFileSync(resolvedSpec, yamlContent, 'utf-8');
      process.stderr.write(`  ${c.cyan('Spec written to:')}      ${resolvedSpec}\n`);

      // Write narrative
      const resolvedNarrative = path.resolve(narrativePath);
      fs.mkdirSync(path.dirname(resolvedNarrative), { recursive: true });
      fs.writeFileSync(resolvedNarrative, mdContent, 'utf-8');
      process.stderr.write(`  ${c.cyan('Narrative written to:')} ${resolvedNarrative}\n`);
    }

    // Output spec as JSON to stdout for piping
    process.stdout.write(JSON.stringify({
      spec,
      narrative: { path: narrativePath },
      files: { spec: specPath, narrative: narrativePath },
    }, null, 2) + '\n');

    rl.close();
    return ExitCode.SUCCESS;
  } catch (err) {
    rl.close();
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      return ExitCode.SUCCESS;
    }
    process.stderr.write(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.PARSE_ERROR;
  }
}
