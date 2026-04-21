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
 *   specify spec generate   --input <dir> --output <path>
 *   specify spec lint       --spec <path|->
 *   specify spec guide
 *   specify capture          --url <url> --output <dir> [--no-generate] [--headed]
 *   specify review           --spec <path> [--report <path>] [--agent-report <path>] [--no-open]
 *   specify create           [--output <path>] [--narrative <path>]
 *   specify replay            --capture <dir> --url <url> [--headed] [--output <dir>]
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

function parseGlobalOptions(args: string[]): { ctx: CliContext; remaining: string[]; debug: boolean } {
  let outputFormat: OutputFormat | undefined;
  let fields: string[] | undefined;
  let quiet = false;
  let debug = false;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--output-format' || arg === '--format') && args[i + 1] && !(args[i + 1].length > 1 && args[i + 1].startsWith('-'))) {
      outputFormat = args[++i] as OutputFormat;
    } else if (arg === '--json') {
      outputFormat = 'json';
    } else if (arg === '--fields' && args[i + 1] && !(args[i + 1].length > 1 && args[i + 1].startsWith('-'))) {
      fields = args[++i].split(',');
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--debug' || arg === '--verbose' || arg === '-v') {
      debug = true;
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
    debug,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value.length > 1 && value.startsWith('-')) return '';
  return value;
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

/** Map an agent error to the appropriate exit code. */
function agentExitCode(err: unknown): number {
  if (err instanceof Error && err.name === 'AgentError') {
    const msg = err.message;
    if (msg.includes('max_turns') || msg.includes('max_budget')) {
      return ExitCode.TIMEOUT;
    }
    if (msg.includes('error_during_execution')) {
      return ExitCode.ASSERTION_FAILURE;
    }
  }
  return ExitCode.BROWSER_ERROR;
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
  ${c.cyan('review')}            Launch the review webapp in a browser
  ${c.cyan('serve')}             Alias for review
  ${c.cyan('ui [start|stop]')}   Interactive UI; add ${c.dim('start')}/${c.dim('stop')} to daemonize
  ${c.cyan('verify')}            Verify an implementation against a contract
  ${c.cyan('impersonate')}       Impersonate a captured system via MockServer

${c.bold('Advanced:')}
  ${c.cyan('lint')}              Validate contract structure ${c.dim('(no captures needed)')}
  ${c.cyan('spec guide')}       Authoring guide for LLM spec writers
  ${c.cyan('spec generate')}    Generate a spec from capture data

${c.bold('Infrastructure:')}
  ${c.cyan('schema')}            JSON Schema introspection ${c.dim('(spec, report, or commands)')}
  ${c.cyan('mcp')}               MCP server for agent integration

${c.dim(`Run "specify human" for interactive guided mode`)}
${c.dim(`Run "specify <command> --help" for command-specific help`)}

${c.bold('Common tasks:')}
  ${c.dim('New project:')}       specify create
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
  const { ctx, remaining, debug } = parseGlobalOptions(process.argv.slice(2));

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

  let exitCode: number = ExitCode.PARSE_ERROR;

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
        const tuiUrl = getArg(rest, '--url') ?? '';
        if (!tuiUrl) {
          process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--url', hint: 'Provide a target URL for the TUI dashboard' }) + '\n');
          exitCode = ExitCode.PARSE_ERROR;
        } else {
          const { runTui } = await import('./interactive/tui.js');
          exitCode = await runTui({
            spec: resolveSpecArg(rest, ctx),
            url: tuiUrl,
          });
        }
      } else if (verb === 'wizard' || verb === 'init') {
        // Legacy wizard mode — preserved for backward compatibility
        const wizardArgs = rest;
        const { runWizard } = await import('./interactive/wizard.js');
        exitCode = await runWizard({
          fromCapture: getArg(wizardArgs, '--from-capture'),
          action: undefined,
          subAction: undefined,
          spec: getArg(wizardArgs, '--spec'),
        });
      } else {
        // Default: chat REPL — freeform text interface
        // e.g. `specify human` or `specify human chat`
        const chatArgs = verb && verb !== 'chat' ? [verb, ...rest] : rest;
        const { runChat } = await import('./interactive/chat.js');
        exitCode = await runChat({
          spec: resolveSpecArg(chatArgs, ctx) || undefined,
          url: getArg(chatArgs, '--url'),
          debug,
        });
      }

    // -----------------------------------------------------------------
    // Agent-friendly commands — structured output to stdout
    // -----------------------------------------------------------------
    } else if (noun === 'spec' && verb === 'generate') {
      const { specGenerate } = await import('./commands/spec-generate.js');
      exitCode = await specGenerate({
        input: getArg(rest, '--input') ?? '',
        output: getArg(rest, '--output'),
        name: getArg(rest, '--name'),
      }, ctx);


    } else if (noun === 'spec' && verb === 'lint') {
      const { specLint } = await import('./commands/spec-lint.js');
      exitCode = await specLint({
        spec: resolveSpecArg(rest, ctx),
      }, ctx);

    } else if (noun === 'spec' && verb === 'guide') {
      const { specGuide } = await import('./commands/spec-guide.js');
      exitCode = await specGuide(ctx);

    } else if (noun === 'capture') {
      // capture is a standalone command (no verb) — recombine args
      const captureArgs = verb ? [verb, ...rest] : rest;
      {
        const human = hasFlag(captureArgs, '--human');
        const url = getArg(captureArgs, '--url') ?? '';
        const output = getArg(captureArgs, '--output') ?? '';

        // Specify IS the agent — use SDK runner for live capture (human mode is the only exception)
        if (!human) {
          if (!url) {
            process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--url', hint: 'Provide the URL to capture' }) + '\n');
            exitCode = ExitCode.PARSE_ERROR;
          } else {
            let validUrl = true;
            try {
              new URL(url);
            } catch {
              process.stdout.write(JSON.stringify({ error: 'invalid_url', url, hint: 'Provide a valid URL (e.g. https://example.com)' }) + '\n');
              exitCode = ExitCode.PARSE_ERROR;
              validUrl = false;
            }
            if (validUrl) {
              const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
              const { getCapturePrompt } = await import('../agent/prompts.js');
              const outputDir = path.resolve(output || '.specify/capture');
              const specOutput = getArg(captureArgs, '--spec-output');
              const specName = getArg(captureArgs, '--spec-name');
              const specOutputPath = path.resolve(specOutput ?? path.join(path.dirname(outputDir), 'spec.yaml'));
              const prompt = getCapturePrompt(url, specOutputPath);
              try {
                const { result, costUsd } = await runSpecifyAgent({
                  task: 'capture',
                  systemPrompt: prompt,
                  userPrompt: `Explore ${url} and generate a comprehensive behavioral spec.`,
                  url,
                  outputDir,
                  specOutput: specOutputPath,
                  specName: specName ?? new URL(url).hostname,
                  headed: hasFlag(captureArgs, '--headed'),
                  debug,
                });
                process.stderr.write(`Agent capture complete (cost: $${costUsd.toFixed(4)})\n`);

                // Post-run validation: verify the spec file exists and parses
                if (!fs.existsSync(specOutputPath)) {
                  process.stderr.write(`Warning: agent did not write spec file at ${specOutputPath}\n`);
                  process.stdout.write(JSON.stringify({ error: 'spec_not_written', costUsd, outputDir, specOutput: specOutputPath }) + '\n');
                  exitCode = ExitCode.PARSE_ERROR;
                } else {
                  try {
                    const { loadSpec } = await import('../spec/parser.js');
                    const spec = loadSpec(specOutputPath);
                    const areaCount = spec.areas?.length ?? 0;
                    process.stderr.write(`Spec validated: ${specOutputPath} (${areaCount} areas)\n`);
                    process.stdout.write(JSON.stringify({ result, costUsd, outputDir, specOutput: specOutputPath, areas: areaCount }) + '\n');
                    exitCode = ExitCode.SUCCESS;

                    process.stderr.write(`\n  To review the spec:\n`);
                    process.stderr.write(`  $ specify review --spec ${specOutputPath}\n\n`);
                  } catch (parseErr) {
                    const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                    process.stderr.write(`Warning: agent wrote invalid spec: ${parseMsg}\n`);
                    process.stdout.write(JSON.stringify({ error: 'invalid_spec', message: parseMsg, costUsd, outputDir, specOutput: specOutputPath }) + '\n');
                    exitCode = ExitCode.PARSE_ERROR;
                  }
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`Agent capture failed: ${msg}\n`);
                process.stdout.write(JSON.stringify({ error: 'agent_error', message: msg }) + '\n');
                exitCode = agentExitCode(err);
              }
            }
          }
        } else {
          const { capture: captureCmd } = await import('./commands/capture.js');
          exitCode = await captureCmd({
            url,
            output,
            headed: hasFlag(captureArgs, '--headed') || human,
            timeout: getArg(captureArgs, '--timeout') ? parseInt(getArg(captureArgs, '--timeout')!) : undefined,
            noScreenshots: hasFlag(captureArgs, '--no-screenshots'),
            noGenerate: hasFlag(captureArgs, '--no-generate'),
            specOutput: getArg(captureArgs, '--spec-output'),
            specName: getArg(captureArgs, '--spec-name'),
            human,
          }, ctx);
        }
      }

    } else if (noun === 'replay') {
      // replay command — recombine args
      const replayArgs = verb ? [verb, ...rest] : rest;
      const captureDir = getArg(replayArgs, '--capture') ?? '';
      const url = getArg(replayArgs, '--url') ?? '';
      if (!captureDir || !url) {
        process.stdout.write(JSON.stringify({ error: 'missing_parameter', hint: 'Provide --capture and --url' }) + '\n');
        exitCode = ExitCode.PARSE_ERROR;
      } else {
        const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
        const { getReplayPrompt } = await import('../agent/prompts.js');
        const outputDir = path.resolve(getArg(replayArgs, '--output') ?? '.specify/replay');
        const prompt = getReplayPrompt(captureDir, url);
        try {
          const { result, costUsd } = await runSpecifyAgent({
            task: 'replay',
            systemPrompt: prompt,
            userPrompt: `Replay traffic from ${captureDir} against ${url}.`,
            url,
            captureDir,
            outputDir,
            headed: hasFlag(replayArgs, '--headed'),
            debug,
          });
          process.stderr.write(`Replay complete (cost: $${costUsd.toFixed(4)})\n`);
          process.stdout.write(JSON.stringify({ result, costUsd, outputDir }) + '\n');
          exitCode = ExitCode.SUCCESS;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Replay failed: ${msg}\n`);
          process.stdout.write(JSON.stringify({ error: 'agent_error', message: msg }) + '\n');
          exitCode = agentExitCode(err);
        }
      }

    } else if (noun === 'compare') {
      const compareArgs = verb ? [verb, ...rest] : rest;
      let remoteUrl = getArg(compareArgs, '--remote') ?? '';
      let localUrl = getArg(compareArgs, '--local') ?? '';
      const remoteAuth = getArg(compareArgs, '--remote-auth');
      const localAuth = getArg(compareArgs, '--local-auth');
      // Embed credentials into URLs (user:pass@host format)
      if (remoteAuth && remoteUrl) {
        try {
          const u = new URL(remoteUrl);
          const [user, ...passParts] = remoteAuth.split(':');
          u.username = encodeURIComponent(user);
          u.password = encodeURIComponent(passParts.join(':'));
          remoteUrl = u.toString();
        } catch { /* URL validation below will catch */ }
      }
      if (localAuth && localUrl) {
        try {
          const u = new URL(localUrl);
          const [user, ...passParts] = localAuth.split(':');
          u.username = encodeURIComponent(user);
          u.password = encodeURIComponent(passParts.join(':'));
          localUrl = u.toString();
        } catch { /* URL validation below will catch */ }
      }

      if (!remoteUrl || !localUrl) {
        process.stdout.write(JSON.stringify({ error: 'missing_parameter', hint: 'Provide both --remote and --local URLs' }) + '\n');
        exitCode = ExitCode.PARSE_ERROR;
      } else {
        let validUrls = true;
        for (const u of [remoteUrl, localUrl]) {
          try { new URL(u); } catch {
            process.stdout.write(JSON.stringify({ error: 'invalid_url', url: u, hint: 'Provide a valid URL (e.g. https://example.com)' }) + '\n');
            exitCode = ExitCode.PARSE_ERROR;
            validUrls = false;
            break;
          }
        }
        if (validUrls) {
          const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
          const { getComparePrompt } = await import('../agent/prompts.js');
          const outputDir = path.resolve(getArg(compareArgs, '--output') ?? '.specify/compare');
          const prompt = getComparePrompt(remoteUrl, localUrl, outputDir);
          try {
            const { result, costUsd, structuredOutput } = await runSpecifyAgent({
              task: 'compare',
              systemPrompt: prompt,
              userPrompt: `Compare remote ${remoteUrl} against local ${localUrl}.`,
              remoteUrl,
              localUrl,
              outputDir,
              headed: hasFlag(compareArgs, '--headed'),
              debug,
            });
            const { extractBool } = await import('../agent/sdk-runner.js');
            const match = extractBool(structuredOutput, 'match');
            process.stderr.write(`Compare complete (cost: $${costUsd.toFixed(4)})\n`);
            process.stdout.write(JSON.stringify({ result, costUsd, outputDir, match, structuredOutput }) + '\n');
            exitCode = match === true ? ExitCode.SUCCESS : ExitCode.ASSERTION_FAILURE;

            // Save structured output for review
            const compareResultPath = path.join(outputDir, 'compare-result.json');
            fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(compareResultPath, JSON.stringify({ structuredOutput }, null, 2), 'utf-8');

            // Human-friendly hint
            const reportPath = path.join(outputDir, 'compare-report.md');
            if (fs.existsSync(reportPath)) {
              process.stderr.write(`\n  Report: ${reportPath}\n`);
            }
            process.stderr.write(`\n  To review interactively:\n`);
            process.stderr.write(`  $ specify review --spec <your-spec.yaml> --agent-report ${compareResultPath}\n\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Compare failed: ${msg}\n`);
            process.stdout.write(JSON.stringify({ error: 'agent_error', message: msg }) + '\n');
            exitCode = agentExitCode(err);
          }
        }
      }

    } else if (noun === 'impersonate') {
      const { impersonateCommand } = await import('./commands/impersonate.js');
      exitCode = await impersonateCommand({
        url: getArg(rest, '--url'),
        capture: getArg(rest, '--capture'),
        port: getArg(rest, '--port'),
        output: getArg(rest, '--output'),
        noAugment: hasFlag(rest, '--no-augment'),
        headed: hasFlag(rest, '--headed'),
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

    } else if (noun === 'daemon') {
      // daemon runs forever until SIGINT/SIGTERM — do not exit
      const daemonArgs = verb ? [verb, ...rest] : rest;
      const { daemonCommand } = await import('./commands/daemon.js');
      await daemonCommand({
        port: getArg(daemonArgs, '--port'),
        host: getArg(daemonArgs, '--host'),
        noAuth: hasFlag(daemonArgs, '--no-auth'),
      }, ctx);
      return;

    } else if (noun === 'serve') {
      // serve is a standalone command (no verb) — recombine args
      const serveArgs = verb ? [verb, ...rest] : rest;
      const { serveCommand } = await import('./commands/serve.js');
      exitCode = await serveCommand({
        spec: resolveSpecArg(serveArgs, ctx),
        port: getArg(serveArgs, '--port'),
        noOpen: hasFlag(serveArgs, '--no-open'),
        agentReport: getArg(serveArgs, '--agent-report'),
      }, ctx);

    } else if (noun === 'review') {
      // review delegates to the webapp server (same as `serve`)
      const reviewArgs = verb ? [verb, ...rest] : rest;
      const { review: reviewCmd } = await import('./commands/review.js');
      exitCode = await reviewCmd({
        spec: resolveSpecArg(reviewArgs, ctx),
        agentReport: getArg(reviewArgs, '--agent-report'),
        port: getArg(reviewArgs, '--port'),
        noOpen: hasFlag(reviewArgs, '--no-open'),
      }, ctx);

    } else if (noun === 'ui') {
      // ui: `specify ui` (foreground), `specify ui start` (daemonize), `specify ui stop` (kill).
      // `stop` needs no spec — skip auto-discovery to avoid noise.
      const uiArgs = verb ? [verb, ...rest] : rest;
      const uiMod = await import('./commands/ui.js');
      if (verb === 'stop') {
        exitCode = await uiMod.uiStop({ spec: '' }, ctx);
      } else {
        const uiOpts = {
          spec: resolveSpecArg(uiArgs, ctx),
          port: getArg(uiArgs, '--port'),
          noOpen: hasFlag(uiArgs, '--no-open'),
          agentReport: getArg(uiArgs, '--agent-report'),
        };
        if (verb === 'start') {
          exitCode = await uiMod.uiStart(uiOpts, ctx);
        } else {
          exitCode = await uiMod.uiInteractive(uiOpts, ctx);
        }
      }

    } else if (noun === 'create') {
      const { create: createCmd } = await import('./commands/create.js');
      exitCode = await createCmd({
        output: getArg(rest, '--output'),
        narrative: getArg(rest, '--narrative'),
      });

    // -----------------------------------------------------------------
    // Top-level lifecycle aliases
    // -----------------------------------------------------------------
    } else if (noun === 'verify') {
      // Agent-driven verification
      const verifyArgs = verb ? [verb, ...rest] : rest;
      const specPath = resolveSpecArg(verifyArgs, ctx);
      const url = getArg(verifyArgs, '--url');

      if (!specPath) {
        process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--spec', hint: 'Provide a spec file to verify against' }) + '\n');
        exitCode = ExitCode.PARSE_ERROR;
      } else {
        const { loadSpec, specToYaml } = await import('../spec/parser.js');
        try {
          const spec = loadSpec(path.resolve(specPath));
          const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
          const { getVerifyPrompt } = await import('../agent/prompts.js');
          const outputDir = path.resolve(getArg(verifyArgs, '--output') ?? '.specify/verify');
          const prompt = getVerifyPrompt(specToYaml(spec));
          // Determine target URL: explicit --url, or from spec target
          const targetUrl = url
            ?? ((spec.target.type === 'web' || spec.target.type === 'api') ? spec.target.url : undefined);
          try {
            const { writeBehaviorProgress } = await import('./output.js');
            const areas = spec.areas?.length ?? 0;
            const behaviors = spec.areas?.reduce((n, a) => n + (a.behaviors?.length ?? 0), 0) ?? 0;
            process.stderr.write(`${c.bold('Verifying')} ${c.cyan(targetUrl ?? 'CLI')} against ${c.cyan(spec.name)} (${areas} areas, ${behaviors} behaviors)\n`);
            process.stderr.write(`${c.dim('Launching agent...')}\n`);
            const { result, costUsd, structuredOutput } = await runSpecifyAgent({
              task: 'verify',
              systemPrompt: prompt,
              userPrompt: targetUrl
                ? `Verify ${targetUrl} against the behavioral spec.`
                : `Verify the CLI at "${spec.target.type === 'cli' ? spec.target.binary : '.'}" against the behavioral spec.`,
              ...(targetUrl ? { url: targetUrl } : {}),
              spec: path.resolve(specPath),
              outputDir,
              headed: hasFlag(verifyArgs, '--headed'),
              debug,
              onBehaviorProgress: writeBehaviorProgress,
            });
            const { extractBool } = await import('../agent/sdk-runner.js');
            const pass = extractBool(structuredOutput, 'pass');
            process.stderr.write(`Verification complete (cost: $${costUsd.toFixed(4)})\n`);
            process.stdout.write(JSON.stringify({ result, costUsd, outputDir, pass, structuredOutput }) + '\n');
            exitCode = pass === true ? ExitCode.SUCCESS : ExitCode.ASSERTION_FAILURE;

            const verifyResultPath = path.join(outputDir, 'verify-result.json');
            fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(verifyResultPath, JSON.stringify({ structuredOutput }, null, 2), 'utf-8');

            process.stderr.write(`\n  To review interactively:\n`);
            process.stderr.write(`  $ specify review --spec ${specPath} --agent-report ${verifyResultPath}\n\n`);
            process.stderr.write(`  To run generated e2e tests:\n`);
            process.stderr.write(`  $ cd ${outputDir} && npx playwright test\n\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Verification failed: ${msg}\n`);
            process.stdout.write(JSON.stringify({ error: 'agent_error', message: msg }) + '\n');
            exitCode = agentExitCode(err);
          }
        } catch (err) {
          process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
          exitCode = ExitCode.PARSE_ERROR;
        }
      }

    } else if (noun === 'clean') {
      // Clean up generated reports and agent output
      const cleanArgs = verb ? [verb, ...rest] : rest;
      const dryRun = hasFlag(cleanArgs, '--dry-run');
      const patterns = [
        '.specify/capture', '.specify/verify', '.specify/compare', '.specify/replay',
        '.specify/evidence',
      ];
      const htmlGlob = '*.review.html';

      let removed = 0;
      // Remove .specify subdirectories
      for (const dir of patterns) {
        const resolved = path.resolve(dir);
        if (fs.existsSync(resolved)) {
          if (dryRun) {
            process.stderr.write(`  Would remove: ${resolved}\n`);
          } else {
            fs.rmSync(resolved, { recursive: true, force: true });
            process.stderr.write(`  Removed: ${resolved}\n`);
          }
          removed++;
        }
      }
      // Remove *.review.html files in cwd
      const cwd = process.cwd();
      for (const f of fs.readdirSync(cwd)) {
        if (f.endsWith('.review.html')) {
          const fullPath = path.join(cwd, f);
          if (dryRun) {
            process.stderr.write(`  Would remove: ${fullPath}\n`);
          } else {
            fs.unlinkSync(fullPath);
            process.stderr.write(`  Removed: ${fullPath}\n`);
          }
          removed++;
        }
      }
      if (removed === 0) {
        process.stderr.write('  Nothing to clean.\n');
      } else if (dryRun) {
        process.stderr.write(`\n  ${removed} items would be removed. Run without --dry-run to delete.\n`);
      } else {
        process.stderr.write(`\n  Cleaned ${removed} items.\n`);
      }
      process.stdout.write(JSON.stringify({ cleaned: removed, dryRun }) + '\n');
      exitCode = ExitCode.SUCCESS;

    } else if (noun === 'lint') {
      // Top-level alias for spec lint
      const lintArgs = verb ? [verb, ...rest] : rest;
      const { specLint } = await import('./commands/spec-lint.js');
      exitCode = await specLint({
        spec: resolveSpecArg(lintArgs, ctx),
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
