import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { writeProgressLine } from '../output.js';

export interface AgentRunOptions {
  spec: string;
  url: string;
  headed?: boolean;
  output?: string;
  explore?: boolean;
  maxExplorationRounds?: number;
  noSetup?: boolean;
  noTeardown?: boolean;
  timeout?: number;
  noScreenshots?: boolean;
}

export async function agentRun(options: AgentRunOptions, ctx: CliContext): Promise<number> {
  const { runAgent } = await import('../../agent/runner.js');

  // Read spec from stdin if '-'
  let specPath = options.spec;
  if (specPath === '-') {
    // Write stdin to temp file for agent runner
    const { writeFileSync, mkdtempSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', resolve);
      process.stdin.on('error', reject);
    });
    const tmpDir = mkdtempSync(join(tmpdir(), 'specify-'));
    specPath = join(tmpDir, 'spec.yaml');
    writeFileSync(specPath, Buffer.concat(chunks).toString('utf-8'));
  }

  const isStreaming = ctx.outputFormat === 'ndjson';
  const log = isStreaming
    ? (msg: string) => writeProgressLine({ type: 'log', message: msg, ts: Date.now() })
    : (msg: string) => { if (!ctx.quiet) process.stderr.write(msg + '\n'); };

  try {
    const result = await runAgent({
      specPath,
      targetUrl: options.url,
      headless: !options.headed,
      outputDir: options.output,
      hooks: {
        setup: !options.noSetup,
        teardown: !options.noTeardown,
      },
      timeout: options.timeout ?? 300_000,
      screenshotOnEveryStep: !options.noScreenshots,
      log,
    });

    const { report } = result;

    if (ctx.outputFormat === 'json') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (isStreaming) {
      writeProgressLine({ type: 'result', report });
    } else if (!ctx.quiet) {
      const { toMarkdown } = await import('../../validation/reporter.js');
      process.stdout.write(toMarkdown(report) + '\n');
    }

    if (result.errors.length > 0) return ExitCode.BROWSER_ERROR;
    if (report.summary.failed > 0) return ExitCode.ASSERTION_FAILURE;
    return ExitCode.SUCCESS;
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return ExitCode.BROWSER_ERROR;
  }
}
