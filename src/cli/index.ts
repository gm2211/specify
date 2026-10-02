#!/usr/bin/env node
import { COMMANDS } from './commands-manifest.js';
import { detectOutputFormat } from './output.js';
import { resolveSpecPath } from './spec-finder.js';
import { ExitCode } from './exit-codes.js';
import type { CliContext, OutputFormat } from './types.js';

import { specLint } from './commands/spec-lint.js';
import { specSplit } from './commands/spec-split.js';
import { specContext } from './commands/spec-context.js';
import { specGuide } from './commands/spec-guide.js';
import { schemaCommand } from './commands/schema.js';
import { version } from '../version.js';
import { specInit } from './commands/spec-init.js';
import { specCheck } from './commands/spec-check.js';
export { COMMANDS };

const globalValues = new Set(['--format', '--output-format', '--fields']);
const globalFlags = new Set(['--json', '--quiet', '-q']);

function parse(args: string[], valueFlags: Set<string>, flags: Set<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      throw new Error(`Repeated option: ${arg}`);
    }
    if (flags.has(arg)) {
      values.set(arg, 'true');
      continue;
    }
    if (!valueFlags.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = args[++i];
    if (!value || (value.startsWith('-') && value !== '-')) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg, value);
  }
  return values;
}

function help(): void {
  process.stdout.write('Specify — maintained specs for coding agents\n\n');
  for (const command of COMMANDS) {
    process.stdout.write(`  ${command.name.padEnd(15)} ${command.description}\n`);
  }
  process.stdout.write(
    '\nGlobal options: --format json|text|markdown|ndjson, --fields paths, --quiet\nUse schema commands for command parameters. Migration: docs/migration-0.4.md\n',
  );
}

async function main(args: string[]): Promise<number> {
  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(version + '\n');
    return 0;
  }
  if (args.length === 0) {
    process.stdout.write(
      JSON.stringify({
        commands: COMMANDS,
        global_options: [...globalValues, ...globalFlags],
        exit_codes: ExitCode,
      }) + '\n',
    );
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    help();
    return 0;
  }
  // Global options may appear before or after the command.
  const globals: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (globalValues.has(args[i])) {
      globals.push(args[i], args[++i]);
    } else if (globalFlags.has(args[i])) {
      globals.push(args[i]);
    } else {
      rest.push(args[i]);
    }
  }
  const global = parse(globals, globalValues, globalFlags);
  const format =
    global.get('--format') ??
    global.get('--output-format') ??
    (global.has('--json') ? 'json' : detectOutputFormat());
  if (!['json', 'text', 'markdown', 'ndjson'].includes(format)) {
    throw new Error(`Unknown output format: ${format}`);
  }
  const ctx: CliContext = {
    outputFormat: format as OutputFormat,
    fields: global.get('--fields')?.split(','),
    quiet: global.has('--quiet') || global.has('-q'),
  };
  const first = rest.shift();
  const name = first === 'spec' ? `${first} ${rest.shift() ?? ''}` : first;
  const command = COMMANDS.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`Unknown or removed command: ${name}. See docs/migration-0.4.md`);
  }
  const target = name === 'schema' ? (rest.shift() ?? '') : '';
  const options = parse(
    rest,
    new Set(
      command.parameters
        .filter((p) => p.type !== 'boolean' && p.name.startsWith('--'))
        .map((p) => p.name),
    ),
    new Set(command.parameters.filter((p) => p.type === 'boolean').map((p) => p.name)),
  );
  const get = (key: string): string | undefined => options.get(key);
  const getSpec = (): string => {
    const result = resolveSpecPath(get('--spec'));
    if (!result.path) {
      throw new Error([result.error ?? 'Missing --spec', ...(result.candidates ?? [])].join('\n'));
    }
    if (result.autoDiscovered && !ctx.quiet) {
      process.stderr.write(`Using auto-discovered spec: ${result.path}\n`);
    }
    return result.path;
  };
  switch (command.name) {
    case 'spec init':
      return specInit({ spec: getSpec(), agents: get('--agents') }, ctx);
    case 'spec check':
      if (!get('--base')) {
        throw new Error('Missing --base: use the task start commit or PR base SHA');
      }
      return specCheck({ spec: getSpec(), base: get('--base')!, reason: get('--reason') }, ctx);
    case 'spec lint':
      return specLint({ spec: get('--spec') === '-' ? '-' : getSpec() }, ctx);
    case 'spec split':
      return specSplit(
        { spec: getSpec(), output: get('--output'), force: options.has('--force') },
        ctx,
      );
    case 'spec context':
      return specContext(
        {
          spec: getSpec(),
          outDir: get('--out-dir'),
          product: get('--product'),
          design: get('--design'),
          force: options.has('--force'),
        },
        ctx,
      );
    case 'spec guide':
      return specGuide(ctx);
    case 'schema':
      return schemaCommand(target, ctx);
    case 'mcp':
      {
        const { startMcpServer } = await import('../mcp/server.js');
        await startMcpServer();
      }
      return 0;
    default:
      throw new Error(`Unknown command: ${name}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ error: 'invalid_input', message }) + '\n');
    process.stderr.write(message + '\n');
    process.exitCode = ExitCode.PARSE_ERROR;
  });
