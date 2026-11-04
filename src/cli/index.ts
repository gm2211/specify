#!/usr/bin/env node
import { COMMANDS } from './commands-manifest.js';
import { detectOutputFormat } from './output.js';
import { ExitCode } from './exit-codes.js';
import type { CliContext, OutputFormat } from './types.js';

import { version } from '../version.js';
import { init } from './commands/init.js';
import { formalCheck } from './commands/formal-check.js';
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
  process.stdout.write('Specify — formal checks for OpenSpec requirements\n\n');
  for (const command of COMMANDS) {
    process.stdout.write(`  ${command.name.padEnd(15)} ${command.description}\n`);
  }
  process.stdout.write(
    '\nGlobal options: --format json|text|markdown|ndjson, --fields paths, --quiet\nRun without arguments for the JSON command manifest. Migration: docs/migration-0.8.md\n',
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
  const name = first === 'formal' ? `${first} ${rest.shift() ?? ''}` : first;
  const command = COMMANDS.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`Unknown or removed command: ${name}. See docs/migration-0.8.md`);
  }
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
  switch (command.name) {
    case 'formal check':
      return formalCheck(
        {
          root: get('--root'),
          tool: get('--tool'),
          change: get('--change'),
          timeoutMs: get('--timeout-ms'),
          quintBin: get('--quint-bin'),
          leanBin: get('--lean-bin'),
        },
        ctx,
      );
    case 'init':
      return init(
        {
          root: get('--root'),
          agents: get('--agents'),
          tools: get('--tools'),
          openspecBin: get('--openspec-bin'),
          skipOpenspec: options.has('--skip-openspec'),
        },
        ctx,
      );
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
