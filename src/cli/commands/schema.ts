import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { COMMANDS } from '../commands-manifest.js';

export async function schemaCommand(target: string, ctx: CliContext): Promise<number> {
  let output: unknown;

  switch (target) {
    case 'spec': {
      const { specSchema } = await import('../../spec/schema.js');
      output = specSchema;
      break;
    }
    case 'commands':
      output = COMMANDS;
      break;
    default:
      process.stderr.write(`Unknown schema target: ${target}. Use: spec or commands\n`);
      return ExitCode.PARSE_ERROR;
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  return ExitCode.SUCCESS;
}
