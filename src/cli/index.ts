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
 *   specify spec evolve     --spec <path> [--pr <number|url>] [--report <path>] [--apply]
 *   specify spec refine     --spec <path> [--report <path>]  (DEPRECATED → delegates to evolve)
 *   specify spec import     --from <path> [--framework playwright|cypress]
 *   specify spec export     --spec <path> --framework playwright|cypress
 *   specify spec sync       --spec <path> --tests <dir>
 *   specify spec lint       --spec <path|->
 *   specify spec guide
 *   specify capture          --url <url> --output <dir> [--no-generate] [--headed]
 *   specify review           --spec <path> [--report <path>] [--no-open]
 *   specify create           [--output <path>] [--narrative <path>]
 *   specify agent run        --spec <path|-> --url <url> [--explore] [--headed]
 *   specify cli run          --spec <path|-> [--output <dir>]
 *   specify report diff      --a <path> --b <path>
 *   specify report stats     --history-dir <dir>
 *   specify schema spec|report|commands
 *   specify mcp              MCP server for LLM tool integration
 *   specify human            Interactive mode (wizard / REPL / TUI)
 *
 * All commands auto-discover --spec from cwd when omitted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectOutputFormat } from './output.js';
import { ExitCode } from './exit-codes.js';
import type { CliContext, OutputFormat } from './types.js';
import { c } from './colors.js';

import { COMMANDS } from './commands-manifest.js';
import { resolveSpecPath } from './spec-finder.js';

// Read version from package.json at startup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function readVersion(): string {
  // Walk up from src/cli/ or dist/src/cli/ to find package.json
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version ?? '0.0.0';
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}
const VERSION = readVersion();

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

/**
 * Resolve --spec: use the provided value, or auto-discover a spec file in cwd.
 * Returns the spec path or '' if not found (commands handle empty string as missing).
 * Logs discovery info to stderr when auto-discovering.
 */
function resolveSpecArg(args: string[], ctx: CliContext): string {
  const explicit = getArg(args, '--spec');
  // If --spec was explicitly provided (even if empty), use it as-is
  if (explicit !== undefined) {
    if (explicit !== '') return explicit;
    // Explicit empty string means the flag was there but value was empty — treat as missing
    return '';
  }

  // --spec not provided at all — try auto-discovery
  const result = resolveSpecPath(undefined);

  if (result.path) {
    if (result.autoDiscovered && !ctx.quiet) {
      process.stderr.write(`Using auto-discovered spec: ${result.path}\n`);
    }
    return result.path;
  }

  if (!ctx.quiet) {
    process.stderr.write(`${result.error}\n`);
    if (result.candidates) {
      for (const candidate of result.candidates) {
        process.stderr.write(`  - ${candidate}\n`);
      }
    }
  }
  return '';
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
      version: VERSION,
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
${c.boldCyan('Specify')} ${c.dim('—')} contract lifecycle for web applications

${c.bold('Usage:')} specify ${c.cyan('<command>')} ${c.dim('[options]')}

${c.bold('Primary Flows:')}
  ${c.cyan('create')}            Create a contract from human intent
  ${c.cyan('capture')}           Capture a contract from a live system or codebase
  ${c.cyan('evolve')}            Evolve a contract from PR, report, or interactively
  ${c.cyan('review')}            Inspect the contract in a browser
  ${c.cyan('verify')}            Verify an implementation against a contract

${c.bold('Advanced:')}
  ${c.cyan('lint')}              Validate contract structure ${c.dim('(no captures needed)')}
  ${c.cyan('spec import')}      Import existing e2e tests as spec items
  ${c.cyan('spec export')}      Export spec items as e2e test code
  ${c.cyan('spec sync')}        Compare contract vs e2e tests
  ${c.cyan('report diff')}      Diff two gap reports
  ${c.cyan('report stats')}     Show statistical confidence from history

${c.bold('Infrastructure:')}
  ${c.cyan('bootstrap')}         Set up specify-driven development workflow
  ${c.cyan('schema')}            JSON Schema introspection ${c.dim('(spec, report, or commands)')}
  ${c.cyan('mcp')}               MCP server for agent integration

${c.dim(`Run "specify human" for interactive guided mode`)}
${c.dim(`Run "specify <command> --help" for command-specific help`)}

${c.bold('Common tasks:')}
  ${c.dim('New project:')}       specify create
  ${c.dim('Add a feature:')}     specify evolve --spec spec.yaml
  ${c.dim('After a PR:')}        specify evolve --spec spec.yaml --pr 42
  ${c.dim('Check it works:')}    specify verify --spec spec.yaml
  ${c.dim('See the contract:')}  specify review --spec spec.yaml

${c.bold('Global Options:')}
  ${c.yellow('--json')}                                        Force JSON output to stdout
  ${c.yellow('--output-format')} ${c.dim('<json|text|markdown|ndjson>')}   Output format ${c.dim('(default: auto-detect)')}
  ${c.yellow('--fields')} ${c.dim('<field1,field2,...>')}                   Select specific fields from output
  ${c.yellow('--quiet, -q')}                                   Suppress non-essential output
  ${c.yellow('--help, -h')}                                    Show this help

${c.bold('Examples:')}
  ${c.dim('$')} specify create
  ${c.dim('$')} specify capture --url http://localhost:3000 --output ./captures
  ${c.dim('$')} specify verify --spec ./spec.yaml --capture ./captures/latest
  ${c.dim('$')} specify evolve --spec ./spec.yaml --pr 42
  ${c.dim('$')} specify review --spec ./spec.yaml
`.trimStart());
  }
}

function printCommandHelp(noun: string, args: string[]): void {
  const verb = args.find(a => a !== noun && a !== '--help' && a !== '-h' && !a.startsWith('-'));
  const searchName = verb ? `${noun} ${verb}` : noun;

  // Find matching commands in manifest
  const matches = COMMANDS.filter(cmd =>
    cmd.name === searchName || cmd.name.startsWith(searchName + ' ') || cmd.name === noun
  );

  if (matches.length === 0) {
    process.stderr.write(`Unknown command: ${searchName}\n\n`);
    printHelp(false);
    return;
  }

  for (const cmd of matches) {
    process.stderr.write(`\n${c.boldCyan('specify ' + cmd.name)}\n`);
    process.stderr.write(`  ${cmd.description}\n\n`);

    if (cmd.parameters.length > 0) {
      process.stderr.write(`${c.bold('Parameters:')}\n`);
      for (const p of cmd.parameters) {
        const req = p.required ? c.red('(required)') : c.dim('(optional)');
        const def = p.default !== undefined ? c.dim(` [default: ${p.default}]`) : '';
        process.stderr.write(`  ${c.yellow(p.name)} ${c.dim(p.type)} ${req}${def}\n`);
        process.stderr.write(`    ${p.description}\n`);
      }
      process.stderr.write('\n');
    }

    if (cmd.modes?.length) {
      process.stderr.write(`${c.bold('Modes:')}\n`);
      for (const mode of cmd.modes) {
        process.stderr.write(`  ${c.cyan(mode.name)} — ${mode.description}\n`);
        process.stderr.write(`    Required: ${mode.required_parameters.join(', ')}\n`);
        if (mode.condition) {
          process.stderr.write(`    ${c.dim('When: ' + mode.condition)}\n`);
        }
      }
      process.stderr.write('\n');
    }

    if (cmd.examples?.length) {
      process.stderr.write(`${c.bold('Examples:')}\n`);
      for (const ex of cmd.examples) {
        process.stderr.write(`  ${c.dim('$')} ${ex}\n`);
      }
      process.stderr.write('\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { ctx, remaining } = parseGlobalOptions(process.argv.slice(2));

  // --version flag
  if (hasFlag(remaining, '--version') || hasFlag(remaining, '-V')) {
    process.stdout.write(VERSION + '\n');
    process.exit(ExitCode.SUCCESS);
    return;
  }

  // --help flag
  if (hasFlag(remaining, '--help') || hasFlag(remaining, '-h')) {
    const helpNoun = remaining.find(a => a !== '--help' && a !== '-h');
    if (helpNoun) {
      // Subcommand help — show command-specific info from manifest
      printCommandHelp(helpNoun, remaining);
    } else {
      printHelp(false);
    }
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
          spec: resolveSpecArg(rest, ctx) || undefined,
          url: getArg(rest, '--url'),
        });
      } else if (verb === 'watch' || verb === 'tui') {
        const { runTui } = await import('./interactive/tui.js');
        exitCode = await runTui({
          spec: resolveSpecArg(rest, ctx),
          url: getArg(rest, '--url') ?? '',
        });
      } else {
        // Default: wizard — pass verb as action for direct path access
        // e.g. `specify human verify` → action='verify'
        //      `specify human verify stats` → action='verify', subAction='stats'
        const wizardArgs = verb ? [verb, ...rest] : rest;
        const { runWizard } = await import('./interactive/wizard.js');
        exitCode = await runWizard({
          fromCapture: getArg(wizardArgs, '--from-capture'),
          action: verb && verb !== 'init' ? verb : undefined,
          subAction: verb && rest.length > 0 && !rest[0].startsWith('-') ? rest[0] : undefined,
          spec: getArg(wizardArgs, '--spec'),
        });
      }

    // -----------------------------------------------------------------
    // Agent-friendly commands — structured output to stdout
    // -----------------------------------------------------------------
    } else if (noun === 'spec' && verb === 'validate') {
      const { specValidate } = await import('./commands/spec-validate.js');
      exitCode = await specValidate({
        spec: resolveSpecArg(rest, ctx),
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
        spec: resolveSpecArg(rest, ctx),
        report: getArg(rest, '--report'),
        url: getArg(rest, '--url'),
        output: getArg(rest, '--output'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'evolve') {
      const { specEvolve } = await import('./commands/spec-evolve.js');
      exitCode = await specEvolve({
        spec: resolveSpecArg(rest, ctx),
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
        spec: resolveSpecArg(rest, ctx),
        framework: getArg(rest, '--framework') ?? '',
        output: getArg(rest, '--output'),
        splitFiles: hasFlag(rest, '--split-files'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'lint') {
      const { specLint } = await import('./commands/spec-lint.js');
      exitCode = await specLint({
        spec: resolveSpecArg(rest, ctx),
      }, ctx);

    } else if (noun === 'spec' && verb === 'guide') {
      const { specGuide } = await import('./commands/spec-guide.js');
      exitCode = await specGuide(ctx);

    } else if (noun === 'spec' && verb === 'sync') {
      const { specSync } = await import('./commands/spec-sync.js');
      exitCode = await specSync({
        spec: resolveSpecArg(rest, ctx),
        tests: getArg(rest, '--tests') ?? '',
        framework: getArg(rest, '--framework'),
      }, ctx);

    } else if (noun === 'capture') {
      // capture is a standalone command (no verb) — recombine args
      const captureArgs = verb ? [verb, ...rest] : rest;
      const from = getArg(captureArgs, '--from') ?? 'live';
      if (from === 'code') {
        // capture --from code delegates to spec import
        const { specImport } = await import('./commands/spec-import.js');
        exitCode = await specImport({
          from: getArg(captureArgs, '--input') ?? '',
          framework: getArg(captureArgs, '--framework'),
          output: getArg(captureArgs, '--output'),
        }, ctx);
      } else {
        const { capture: captureCmd } = await import('./commands/capture.js');
        exitCode = await captureCmd({
          url: getArg(captureArgs, '--url') ?? '',
          output: getArg(captureArgs, '--output') ?? '',
          headed: hasFlag(captureArgs, '--headed'),
          timeout: getArg(captureArgs, '--timeout') ? parseInt(getArg(captureArgs, '--timeout')!) : undefined,
          noScreenshots: hasFlag(captureArgs, '--no-screenshots'),
          noGenerate: hasFlag(captureArgs, '--no-generate'),
          specOutput: getArg(captureArgs, '--spec-output'),
          specName: getArg(captureArgs, '--spec-name'),
        }, ctx);
      }

    } else if (noun === 'agent' && verb === 'run') {
      const { agentRun } = await import('./commands/agent-run.js');
      exitCode = await agentRun({
        spec: resolveSpecArg(rest, ctx),
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
        spec: resolveSpecArg(rest, ctx),
        output: getArg(rest, '--output'),
        historyDir: getArg(rest, '--history-dir'),
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

    } else if (noun === 'review') {
      // review is a standalone command (no verb) — recombine args
      const reviewArgs = verb ? [verb, ...rest] : rest;
      const { review: reviewCmd } = await import('./commands/review.js');
      exitCode = await reviewCmd({
        spec: resolveSpecArg(reviewArgs, ctx),
        narrative: getArg(reviewArgs, '--narrative'),
        report: getArg(reviewArgs, '--report'),
        output: getArg(reviewArgs, '--output'),
        noOpen: hasFlag(reviewArgs, '--no-open'),
      }, ctx);

    } else if (noun === 'create') {
      const { create: createCmd } = await import('./commands/create.js');
      exitCode = await createCmd({
        output: getArg(rest, '--output'),
        narrative: getArg(rest, '--narrative'),
      });

    // -----------------------------------------------------------------
    // Top-level lifecycle aliases
    // -----------------------------------------------------------------
    } else if (noun === 'evolve') {
      // Top-level alias for spec evolve
      const evolveArgs = verb ? [verb, ...rest] : rest;
      const { specEvolve } = await import('./commands/spec-evolve.js');
      exitCode = await specEvolve({
        spec: resolveSpecArg(evolveArgs, ctx),
        pr: getArg(evolveArgs, '--pr'),
        repo: getArg(evolveArgs, '--repo'),
        report: getArg(evolveArgs, '--report'),
        apply: hasFlag(evolveArgs, '--apply'),
        output: getArg(evolveArgs, '--output'),
        url: getArg(evolveArgs, '--url'),
      }, ctx);

    } else if (noun === 'verify') {
      // Unified verification dispatcher
      // Routing: explicit flags > spec auto-detection
      const verifyArgs = verb && verb !== 'cli' ? [verb, ...rest] : rest;
      const specPath = verb === 'cli' ? resolveSpecArg(rest, ctx) : resolveSpecArg(verifyArgs, ctx);
      const url = getArg(verifyArgs, '--url');
      const capture = getArg(verifyArgs, '--capture');

      if (verb === 'cli') {
        // Explicit: verify cli → cli run (backward compat)
        const { cliRun } = await import('./commands/cli-run.js');
        exitCode = await cliRun({
          spec: specPath,
          output: getArg(rest, '--output'),
          historyDir: getArg(rest, '--history-dir'),
        }, ctx);
      } else if (url && !capture) {
        // verify --url (no --capture) → agent run
        const { agentRun } = await import('./commands/agent-run.js');
        exitCode = await agentRun({
          spec: specPath,
          url: url,
          headed: hasFlag(verifyArgs, '--headed'),
          output: getArg(verifyArgs, '--output'),
          explore: hasFlag(verifyArgs, '--explore'),
          maxExplorationRounds: getArg(verifyArgs, '--max-exploration-rounds') ? parseInt(getArg(verifyArgs, '--max-exploration-rounds')!) : undefined,
          noSetup: hasFlag(verifyArgs, '--no-setup'),
          noTeardown: hasFlag(verifyArgs, '--no-teardown'),
          timeout: getArg(verifyArgs, '--timeout') ? parseInt(getArg(verifyArgs, '--timeout')!) : undefined,
          noScreenshots: hasFlag(verifyArgs, '--no-screenshots'),
        }, ctx);
      } else if (capture) {
        // verify --capture → spec validate
        const { specValidate } = await import('./commands/spec-validate.js');
        exitCode = await specValidate({
          spec: specPath,
          capture: capture,
          output: getArg(verifyArgs, '--output'),
          historyDir: getArg(verifyArgs, '--history-dir'),
        }, ctx);
      } else {
        // No explicit target — auto-detect from spec
        // Load the spec to check what sections it has
        const { loadSpec } = await import('../spec/parser.js');
        try {
          const spec = loadSpec(specPath);
          if (spec.cli) {
            // Spec has a cli section → run CLI verification
            const { cliRun } = await import('./commands/cli-run.js');
            exitCode = await cliRun({
              spec: specPath,
              output: getArg(verifyArgs, '--output'),
              historyDir: getArg(verifyArgs, '--history-dir'),
            }, ctx);
          } else if (spec.pages?.length) {
            // Spec has pages but no URL — can't verify without a target
            process.stderr.write('Spec has pages but no --url or --capture provided. Provide a target to verify against.\n');
            exitCode = ExitCode.PARSE_ERROR;
          } else {
            process.stderr.write('Spec has no verifiable sections (no cli, no pages). Nothing to verify.\n');
            exitCode = ExitCode.PARSE_ERROR;
          }
        } catch (err) {
          process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
          exitCode = ExitCode.PARSE_ERROR;
        }
      }

    } else if (noun === 'lint') {
      // Top-level alias for spec lint
      const lintArgs = verb ? [verb, ...rest] : rest;
      const { specLint } = await import('./commands/spec-lint.js');
      exitCode = await specLint({
        spec: resolveSpecArg(lintArgs, ctx),
      }, ctx);

    } else if (noun === 'bootstrap') {
      const bootstrapArgs = verb ? [verb, ...rest] : rest;
      const { bootstrap: bootstrapCmd } = await import('./commands/bootstrap.js');
      exitCode = await bootstrapCmd({
        dryRun: hasFlag(bootstrapArgs, '--dry-run'),
        targetDir: getArg(bootstrapArgs, '--target-dir') ?? '.',
        spec: getArg(bootstrapArgs, '--spec') || resolveSpecArg(bootstrapArgs, ctx) || undefined,
      }, ctx);

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
