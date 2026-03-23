/**
 * src/cli/commands/create.ts — Interactive spec creation
 *
 * `specify create [--output <path>]`
 *
 * Quick interactive prompt that produces a v2 behavioral spec.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Spec } from '../../spec/types.js';
import { specToYaml } from '../../spec/parser.js';
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

  const ask = (question: string, defaultVal?: string): Promise<string> =>
    new Promise((resolve) => {
      const suffix = defaultVal ? ` ${c.dim(`[${defaultVal}]`)}` : '';
      rl.question(`  ${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultVal || '');
      });
    });

  const confirm = (question: string, defaultYes = true): Promise<boolean> =>
    new Promise((resolve) => {
      const hint = defaultYes ? c.dim('[Y/n]') : c.dim('[y/N]');
      rl.question(`  ${question} ${hint} `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === '') resolve(defaultYes);
        else resolve(a === 'y' || a === 'yes');
      });
    });

  try {
    process.stderr.write(`\n  ${c.boldCyan('Specify')} ${c.dim('—')} Spec Creator\n`);
    process.stderr.write(`  ${'═'.repeat(30)}\n\n`);

    const name = await ask('App name', 'my-app');
    const description = await ask('Description', `Behavioral contract for ${name}`);
    const targetType = await ask('Target type (web/cli/api)', 'web');
    const targetValue = targetType === 'cli'
      ? await ask('Binary path', './my-app')
      : await ask('URL', 'http://localhost:3000');

    const target = targetType === 'cli'
      ? { type: 'cli' as const, binary: targetValue }
      : targetType === 'api'
        ? { type: 'api' as const, url: targetValue }
        : { type: 'web' as const, url: targetValue };

    const spec: Spec = {
      version: '2',
      name,
      description,
      target,
      areas: [],
    };

    const specPath = options.output ?? 'spec.yaml';
    const yamlContent = specToYaml(spec);

    process.stderr.write(`\n${c.dim('--- spec ---')}\n`);
    for (const line of yamlContent.split('\n')) {
      process.stderr.write(`  ${line}\n`);
    }
    process.stderr.write(`${c.dim('--- end ---')}\n`);

    const shouldSave = await confirm(`\nSave to ${specPath}?`, true);

    if (shouldSave) {
      const resolved = path.resolve(specPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, yamlContent, 'utf-8');
      process.stderr.write(`  ${c.cyan('Spec written to:')} ${resolved}\n`);
      process.stderr.write(`  ${c.dim('Add areas and behaviors to define your contract.')}\n`);
    }

    process.stdout.write(JSON.stringify({ spec, files: { spec: specPath } }, null, 2) + '\n');

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
