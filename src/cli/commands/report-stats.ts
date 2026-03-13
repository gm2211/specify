import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { createHistoryStore } from '../../history/store.js';
import { computeStats, statsToMarkdown } from '../../history/statistics.js';
import { formatOutput } from '../output.js';

export interface ReportStatsOptions {
  historyDir: string;
}

export async function reportStats(options: ReportStatsOptions, ctx: CliContext): Promise<number> {
  if (!options.historyDir) {
    process.stderr.write('Error: --history-dir is required\n');
    return ExitCode.PARSE_ERROR;
  }

  const store = createHistoryStore(options.historyDir);
  const ids = store.list();

  if (ids.length === 0) {
    process.stderr.write('No reports found in history directory\n');
    return ExitCode.ALL_UNTESTED;
  }

  const reports = ids.map(id => store.load(id));
  const stats = computeStats(reports);

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(formatOutput(stats, ctx) + '\n');
  } else {
    process.stdout.write(statsToMarkdown(stats) + '\n');
  }

  return ExitCode.SUCCESS;
}
