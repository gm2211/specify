import type { OutputFormat, CliContext } from './types.js';
import { selectFields } from './field-selector.js';
import { c } from './colors.js';
import type { BehaviorProgress } from '../agent/sdk-runner.js';

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

/** Write a color-coded behavior progress line to stderr. */
export function writeBehaviorProgress(progress: BehaviorProgress): void {
  const icon = progress.status === 'passed' ? c.green('✓')
    : progress.status === 'failed' ? c.red('✗')
    : c.yellow('-');
  const id = progress.status === 'failed' ? c.red(progress.id) : c.dim(progress.id);
  const time = progress.duration_ms != null ? c.dim(` (${(progress.duration_ms / 1000).toFixed(1)}s)`) : '';
  const desc = progress.description ? `  ${progress.description}` : '';
  process.stderr.write(`  ${icon} ${id}${time}${desc}\n`);
}
