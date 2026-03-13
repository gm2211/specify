import type { OutputFormat, CliContext } from './types.js';
import { selectFields } from './field-selector.js';

/** Auto-detect output format based on TTY. */
export function detectOutputFormat(): OutputFormat {
  return process.stdout.isTTY ? 'text' : 'json';
}

/** Format output based on format and optional field selection. */
export function formatOutput(data: unknown, ctx: CliContext): string {
  const result = ctx.fields ? selectFields(data, ctx.fields) : data;

  switch (ctx.outputFormat) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'ndjson':
      if (Array.isArray(result)) {
        return result.map(item => JSON.stringify(item)).join('\n');
      }
      return JSON.stringify(result);
    case 'markdown':
      // For markdown, use the report module's toMarkdown if available
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    case 'text':
    default:
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
}

/** Write output to stdout. */
export function writeOutput(data: unknown, ctx: CliContext): void {
  if (ctx.quiet) return;
  const formatted = formatOutput(data, ctx);
  process.stdout.write(formatted + '\n');
}

/** Write NDJSON line for streaming progress. */
export function writeProgressLine(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}
