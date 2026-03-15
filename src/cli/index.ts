#!/usr/bin/env node

/**
 * src/cli/index.ts — Agent-friendly CLI entry point for Specify
 *
 * Design principles (agent-first):
 *   - Structured JSON to stdout, human messages to stderr
 *   - Meaningful exit codes for branching (0, 1, 2, 10-14)
 *   - Noun-verb command pattern for tree-search discovery
 *   - Schema introspection via `specify schema <target>`
 *   - Field masks via --fields for context-window discipline
 *   - Stdin support (--spec -) for piping
 *   - TTY auto-detection: pretty text for humans, JSON for pipes
 *   - `specify human` enters interactive mode (wizard, REPL, TUI)
 *
 * Command structure:
 *   specify spec validate   --spec <path|-> --capture <dir>
 *   specify spec generate   --input <dir> --output <path> [--smart]
 *   specify spec evolve    --spec <path> [--pr <number|url>] [--repo <owner/repo>]
 *                                        [--report <path>] [--apply] [--output <path>] [--url <url>]
 *   specify spec refine     --spec <path> [--report <path>] [--url <url>]  (DEPRECATED → delegates to evolve)
 *   specify spec import    --from <path> [--framework playwright|cypress]
 *   specify spec export    --spec <path> --framework playwright|cypress
 *   specify spec sync      --spec <path> --tests <dir>
 *   specify spec lint      --spec <path|->
 *   specify spec guide
 *   specify capture          --url <url> --output <dir> [--headed] [--timeout <ms>] [--no-screenshots]
 *   specify agent run       --spec <path|-> --url <url> [--explore] [--headed]
 *   specify cli run         --spec <path|-> [--output <dir>]
 *   specify report diff     --a <path> --b <path>
 *   specify report stats    --history-dir <dir>
 *   specify schema spec|report|commands
 *   specify mcp             MCP server for LLM tool integration
 *   specify human           Interactive mode (wizard / REPL / TUI)
 */

import { detectOutputFormat } from './output.js';
import { ExitCode } from './exit-codes.js';
import type { CliContext, OutputFormat } from './types.js';
import { c } from './colors.js';

import { COMMANDS } from './commands-manifest.js';

// Re-export for external consumers
export { COMMANDS };

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseGlobalOptions(args: string[]): { ctx: CliContext; remaining: string[] } {
  let outputFormat: OutputFormat | undefined;
  let fields: string[] | undefined;
  let quiet = false;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--output-format' || arg === '--format') && args[i + 1]) {
      outputFormat = args[++i] as OutputFormat;
    } else if (arg === '--json') {
      outputFormat = 'json';
    } else if (arg === '--fields' && args[i + 1]) {
      fields = args[++i].split(',');
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else {
      remaining.push(arg);
    }
  }

  return {
    ctx: {
      outputFormat: outputFormat ?? detectOutputFormat(),
      fields,
      quiet,
    },
    remaining,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// ---------------------------------------------------------------------------
// Help — structured for agents, readable for humans
// ---------------------------------------------------------------------------

function printHelp(asJson: boolean): void {
  if (asJson) {
    // Agent-friendly: emit command manifest as JSON to stdout
    process.stdout.write(JSON.stringify({
      name: 'specify',
      version: '0.1.0',
      description: 'Spec-driven functional verification for web applications',
      commands: COMMANDS,
      global_options: [
        { name: '--json', description: 'Force JSON output' },
        { name: '--output-format', type: 'string', description: 'Output format: json|text|markdown|ndjson' },
        { name: '--fields', type: 'string', description: 'Comma-separated field paths to select from output' },
        { name: '--quiet', description: 'Suppress non-essential output' },
      ],
      exit_codes: {
        '0': 'success',
        '1': 'assertion_failure',
        '2': 'all_untested',
        '10': 'parse_error',
        '11': 'network_error',
        '12': 'timeout',
        '13': 'assumption_failure',
        '14': 'browser_error',
      },
      hint: 'Run "specify schema commands" for full parameter schemas. Run "specify human" for interactive mode.',
    }, null, 2) + '\n');
  } else {
    // Human-readable to stderr
    process.stderr.write(`
${c.boldCyan('Specify')} ${c.dim('—')} spec-driven functional verification

${c.bold('Usage:')} specify ${c.cyan('<noun>')} ${c.cyan('<verb>')} ${c.dim('[options]')}

${c.bold('Commands:')}
  ${c.cyan('spec validate')}    Validate a spec against captured data
  ${c.cyan('spec generate')}    Generate a spec from capture data
  ${c.cyan('spec evolve')}      Evolve a spec from PR, gap report, or interactively
  ${c.dim('spec refine')}      ${c.dim('(deprecated — use spec evolve)')}
  ${c.cyan('spec import')}      Import existing e2e tests as spec items
  ${c.cyan('spec export')}      Export spec items as e2e test code
  ${c.cyan('spec sync')}        Compare spec against e2e tests bidirectionally
  ${c.cyan('spec lint')}        Validate spec structure ${c.dim('(no captures needed)')}
  ${c.cyan('spec guide')}       Output authoring guide for LLM spec writers
  ${c.cyan('capture')}           Capture traffic, logs, and screenshots from a URL
  ${c.cyan('agent run')}        Run autonomous agent-driven verification
  ${c.cyan('cli run')}          Run CLI verification against a spec
  ${c.cyan('report diff')}      Diff two gap reports
  ${c.cyan('report stats')}     Show statistical confidence from history
  ${c.cyan('schema')}           Output JSON Schema ${c.dim('(spec, report, or commands)')}
  ${c.cyan('mcp')}              Start MCP server for LLM tool integration
  ${c.cyan('human')}            Interactive mode ${c.dim('(wizard, REPL, TUI)')}

${c.bold('Global Options:')}
  ${c.yellow('--json')}                                        Force JSON output to stdout
  ${c.yellow('--output-format')} ${c.dim('<json|text|markdown|ndjson>')}   Output format ${c.dim('(default: auto-detect)')}
  ${c.yellow('--fields')} ${c.dim('<field1,field2,...>')}                   Select specific fields from output
  ${c.yellow('--quiet, -q')}                                   Suppress non-essential output
  ${c.yellow('--help, -h')}                                    Show this help

${c.bold('Examples:')}
  ${c.dim('$')} specify spec validate --spec ./spec.yaml --capture ./captures/latest
  ${c.dim('$')} specify agent run --spec ./spec.yaml --url http://localhost:3000
  ${c.dim('$')} specify human
`.trimStart());
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { ctx, remaining } = parseGlobalOptions(process.argv.slice(2));

  // --help flag: always human-readable text to stderr
  if (hasFlag(remaining, '--help') || hasFlag(remaining, '-h')) {
    printHelp(false);
    process.exit(ExitCode.SUCCESS);
    return;
  }

  // No arguments: always JSON — agent-friendly self-description
  // Humans should run `specify --help` for text or `specify human` for interactive
  if (remaining.length === 0) {
    printHelp(true);
    process.exit(ExitCode.SUCCESS);
    return;
  }

  const [noun, verb, ...rest] = remaining;

  let exitCode: number;

  try {
    // -----------------------------------------------------------------
    // Interactive modes — `specify human [init|shell|watch]`
    // -----------------------------------------------------------------
    if (noun === 'human') {
      if (verb === 'shell' || verb === 'repl') {
        const { runRepl } = await import('./interactive/repl.js');
        exitCode = await runRepl({
          spec: getArg(rest, '--spec'),
          url: getArg(rest, '--url'),
        });
      } else if (verb === 'watch' || verb === 'tui') {
        const { runTui } = await import('./interactive/tui.js');
        exitCode = await runTui({
          spec: getArg(rest, '--spec') ?? '',
          url: getArg(rest, '--url') ?? '',
        });
      } else {
        // Default: wizard (covers `specify human` and `specify human init`)
        const { runWizard } = await import('./interactive/wizard.js');
        exitCode = await runWizard({
          fromCapture: getArg(remaining.slice(1), '--from-capture'),
        });
      }

    // -----------------------------------------------------------------
    // Agent-friendly commands — structured output to stdout
    // -----------------------------------------------------------------
    } else if (noun === 'spec' && verb === 'validate') {
      const { specValidate } = await import('./commands/spec-validate.js');
      exitCode = await specValidate({
        spec: getArg(rest, '--spec') ?? '',
        capture: getArg(rest, '--capture') ?? '',
        output: getArg(rest, '--output'),
        historyDir: getArg(rest, '--history-dir'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'generate') {
      const { specGenerate } = await import('./commands/spec-generate.js');
      exitCode = await specGenerate({
        input: getArg(rest, '--input') ?? '',
        output: getArg(rest, '--output'),
        name: getArg(rest, '--name'),
        smart: hasFlag(rest, '--smart'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'refine') {
      const { specRefine } = await import('./commands/spec-refine.js');
      exitCode = await specRefine({
        spec: getArg(rest, '--spec') ?? '',
        report: getArg(rest, '--report'),
        url: getArg(rest, '--url'),
        output: getArg(rest, '--output'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'evolve') {
      const { specEvolve } = await import('./commands/spec-evolve.js');
      exitCode = await specEvolve({
        spec: getArg(rest, '--spec') ?? '',
        pr: getArg(rest, '--pr'),
        repo: getArg(rest, '--repo'),
        report: getArg(rest, '--report'),
        apply: hasFlag(rest, '--apply'),
        output: getArg(rest, '--output'),
        url: getArg(rest, '--url'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'import') {
      const { specImport } = await import('./commands/spec-import.js');
      exitCode = await specImport({
        from: getArg(rest, '--from') ?? '',
        framework: getArg(rest, '--framework'),
        output: getArg(rest, '--output'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'export') {
      const { specExport } = await import('./commands/spec-export.js');
      exitCode = await specExport({
        spec: getArg(rest, '--spec') ?? '',
        framework: getArg(rest, '--framework') ?? '',
        output: getArg(rest, '--output'),
        splitFiles: hasFlag(rest, '--split-files'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'lint') {
      const { specLint } = await import('./commands/spec-lint.js');
      exitCode = await specLint({
        spec: getArg(rest, '--spec') ?? '',
      }, ctx);

    } else if (noun === 'spec' && verb === 'guide') {
      const { specGuide } = await import('./commands/spec-guide.js');
      exitCode = await specGuide(ctx);

    } else if (noun === 'spec' && verb === 'sync') {
      const { specSync } = await import('./commands/spec-sync.js');
      exitCode = await specSync({
        spec: getArg(rest, '--spec') ?? '',
        tests: getArg(rest, '--tests') ?? '',
        framework: getArg(rest, '--framework'),
      }, ctx);

    } else if (noun === 'capture') {
      // capture is a standalone command (no verb) — recombine args
      const captureArgs = verb ? [verb, ...rest] : rest;
      const { capture: captureCmd } = await import('./commands/capture.js');
      exitCode = await captureCmd({
        url: getArg(captureArgs, '--url') ?? '',
        output: getArg(captureArgs, '--output') ?? '',
        headed: hasFlag(captureArgs, '--headed'),
        timeout: getArg(captureArgs, '--timeout') ? parseInt(getArg(captureArgs, '--timeout')!) : undefined,
        noScreenshots: hasFlag(captureArgs, '--no-screenshots'),
      }, ctx);

    } else if (noun === 'agent' && verb === 'run') {
      const { agentRun } = await import('./commands/agent-run.js');
      exitCode = await agentRun({
        spec: getArg(rest, '--spec') ?? '',
        url: getArg(rest, '--url') ?? '',
        headed: hasFlag(rest, '--headed'),
        output: getArg(rest, '--output'),
        explore: hasFlag(rest, '--explore'),
        maxExplorationRounds: getArg(rest, '--max-exploration-rounds') ? parseInt(getArg(rest, '--max-exploration-rounds')!) : undefined,
        noSetup: hasFlag(rest, '--no-setup'),
        noTeardown: hasFlag(rest, '--no-teardown'),
        timeout: getArg(rest, '--timeout') ? parseInt(getArg(rest, '--timeout')!) : undefined,
        noScreenshots: hasFlag(rest, '--no-screenshots'),
      }, ctx);

    } else if (noun === 'cli' && verb === 'run') {
      const { cliRun } = await import('./commands/cli-run.js');
      exitCode = await cliRun({
        spec: getArg(rest, '--spec') ?? '',
        output: getArg(rest, '--output'),
      }, ctx);

    } else if (noun === 'report' && verb === 'diff') {
      const { reportDiff } = await import('./commands/report-diff.js');
      exitCode = await reportDiff({
        a: getArg(rest, '--a') ?? '',
        b: getArg(rest, '--b') ?? '',
      }, ctx);

    } else if (noun === 'report' && verb === 'stats') {
      const { reportStats } = await import('./commands/report-stats.js');
      exitCode = await reportStats({
        historyDir: getArg(rest, '--history-dir') ?? '',
      }, ctx);

    } else if (noun === 'schema') {
      const { schemaCommand } = await import('./commands/schema.js');
      exitCode = await schemaCommand(verb ?? '', ctx);

    } else if (noun === 'mcp') {
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer({
        http: hasFlag(remaining, '--http'),
        port: getArg(remaining, '--port') ? parseInt(getArg(remaining, '--port')!) : undefined,
        host: getArg(remaining, '--host'),
      });
      // MCP server runs until client disconnects — don't exit
      return;

    } else if (noun === 'site') {
      // site is a standalone command (no verb) — recombine args
      const siteArgs = verb ? [verb, ...rest] : rest;
      const { site: siteCmd } = await import('./commands/site.js');
      exitCode = await siteCmd({
        spec: getArg(siteArgs, '--spec') ?? '',
        narrative: getArg(siteArgs, '--narrative'),
        report: getArg(siteArgs, '--report'),
        output: getArg(siteArgs, '--output'),
      }, ctx);

    } else if (noun === 'create') {
      const { create: createCmd } = await import('./commands/create.js');
      exitCode = await createCmd({
        output: getArg(rest, '--output'),
        narrative: getArg(rest, '--narrative'),
      });

    } else {
      // Unknown command — structured error
      const error = { error: 'unknown_command', command: `${noun} ${verb ?? ''}`.trim(), hint: 'Run "specify schema commands" for available commands' };
      if (ctx.outputFormat === 'json' || !process.stdout.isTTY) {
        process.stdout.write(JSON.stringify(error) + '\n');
      } else {
        process.stderr.write(`Unknown command: ${error.command}\n`);
        printHelp(false);
      }
      exitCode = ExitCode.PARSE_ERROR;
    }
  } catch (err) {
    const error = { error: 'internal_error', message: err instanceof Error ? err.message : String(err) };
    if (ctx.outputFormat === 'json' || !process.stdout.isTTY) {
      process.stdout.write(JSON.stringify(error) + '\n');
    }
    process.stderr.write(`Error: ${error.message}\n`);
    exitCode = ExitCode.PARSE_ERROR;
  }

  process.exit(exitCode);
}

main();
