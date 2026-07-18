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
 *   - `specify human` enters interactive chat REPL
 *
 * Command structure:
 *   specify spec generate   --input <dir> --output <path>
 *   specify spec lint       --spec <path|->
 *   specify spec split      --spec <path> --output <dir>
 *   specify spec guide
 *   specify spec migrate-id  <old-fq-id> <new-fq-id> [--spec <path>]
 *   specify spec compile     [--spec <path>] [--behavior <fq-id> ...] [--force]
 *   specify capture          --url <url> --output <dir> [--no-generate] [--headed]
 *   specify review           --spec <path> [--report <path>] [--agent-report <path>] [--no-open]
 *   specify create           [--output <path>] [--narrative <path>]
 *   specify replay            --capture <dir> --url <url> [--headed] [--output <dir>]
 *   specify schema spec|report|commands
 *   specify mcp              MCP server for LLM tool integration
 *   specify human            Interactive chat REPL
 *
 * All commands auto-discover --spec from cwd when omitted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectOutputFormat } from './output.js';
import { ExitCode } from './exit-codes.js';
import type { CliContext, OutputFormat } from './types.js';
import type { BehaviorResult } from '../spec/types.js';
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

/** Collect every value for a repeatable flag (e.g. `--behavior a/b --behavior c/d`). */
function getAllArgs(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

/**
 * Extract positional (non-flag) arguments, skipping any of `valueFlags` and
 * the value that follows them (e.g. `--spec path.yaml`).
 */
function collectPositionals(args: string[], valueFlags: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) {
      i++; // skip the flag's value
      continue;
    }
    if (args[i].startsWith('-')) continue;
    positionals.push(args[i]);
  }
  return positionals;
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
  ${c.cyan('review')}            Launch the review webapp ${c.dim('(--background to daemonize, --stop to kill)')}
  ${c.cyan('verify')}            Verify an implementation against a contract

${c.bold('Advanced:')}
  ${c.cyan('spec lint')}         Validate contract structure ${c.dim('(no captures needed)')}
  ${c.cyan('spec split')}        Break a large spec file into a directory spec
  ${c.cyan('spec guide')}       Authoring guide for LLM spec writers
  ${c.cyan('spec generate')}    Generate a spec from capture data
  ${c.cyan('spec migrate-id')}  Rewrite learned-state keys after a behavior/area id rename
  ${c.cyan('spec compile')}     Compile behaviors into LTLf formulas for deterministic verify

${c.bold('Infrastructure:')}
  ${c.cyan('schema')}            JSON Schema introspection ${c.dim('(spec, report, or commands)')}
  ${c.cyan('mcp')}               MCP server for agent integration

${c.dim(`Run "specify human" for interactive chat REPL`)}
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
    // Interactive chat mode
    // -----------------------------------------------------------------
    if (noun === 'human') {
      // Always run chat REPL — pass any extra args through.
      const chatArgs = verb && verb !== 'chat' ? [verb, ...rest] : rest;
      const { runChat } = await import('./interactive/chat.js');
      exitCode = await runChat({
        spec: resolveSpecArg(chatArgs, ctx) || undefined,
        url: getArg(chatArgs, '--url'),
        debug,
      });

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

    } else if (noun === 'spec' && verb === 'split') {
      const { specSplit } = await import('./commands/spec-split.js');
      exitCode = await specSplit({
        spec: resolveSpecArg(rest, ctx),
        output: getArg(rest, '--output'),
        force: hasFlag(rest, '--force'),
      }, ctx);

    } else if (noun === 'spec' && verb === 'guide') {
      const { specGuide } = await import('./commands/spec-guide.js');
      exitCode = await specGuide(ctx);

    } else if (noun === 'spec' && verb === 'migrate-id') {
      const { specMigrateId } = await import('./commands/spec-migrate-id.js');
      const positionals = collectPositionals(rest, ['--spec']);
      exitCode = await specMigrateId({
        spec: resolveSpecArg(rest, ctx),
        oldId: positionals[0] ?? '',
        newId: positionals[1] ?? '',
      }, ctx);

    } else if (noun === 'spec' && verb === 'compile') {
      const { specCompile } = await import('./commands/spec-compile.js');
      exitCode = await specCompile({
        spec: resolveSpecArg(rest, ctx),
        behavior: getAllArgs(rest, '--behavior'),
        force: hasFlag(rest, '--force'),
        debug,
      }, ctx);

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
        maxWorkers: getArg(daemonArgs, '--max-workers'),
      }, ctx);
      return;

    } else if (noun === 'review') {
      // `--stop` needs no spec — skip auto-discovery to avoid noise.
      const reviewArgs = verb ? [verb, ...rest] : rest;
      const stop = hasFlag(reviewArgs, '--stop');
      const background = hasFlag(reviewArgs, '--background');
      const { review: reviewCmd } = await import('./commands/review.js');
      exitCode = await reviewCmd({
        spec: stop ? '' : resolveSpecArg(reviewArgs, ctx),
        agentReport: getArg(reviewArgs, '--agent-report'),
        port: getArg(reviewArgs, '--port'),
        noOpen: hasFlag(reviewArgs, '--no-open'),
        background,
        stop,
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
    } else if (noun === 'verify') {
      // Agent-driven verification
      const verifyArgs = verb ? [verb, ...rest] : rest;
      const specPath = resolveSpecArg(verifyArgs, ctx);
      const url = getArg(verifyArgs, '--url');
      const withContextPath = getArg(verifyArgs, '--with-context');
      const verifyMode = getArg(verifyArgs, '--mode') ?? 'agent';
      const crossCheck = hasFlag(verifyArgs, '--cross-check');
      // SP-9kp escape hatch: restore the pre-routing auto behavior (run the
      // FULL scripted suite first, escalate failures) instead of the
      // confidence-driven partition. Cheap A/B lever.
      const routeAllScripted = hasFlag(verifyArgs, '--route-all-scripted');

      if (!specPath) {
        process.stdout.write(JSON.stringify({ error: 'missing_parameter', parameter: '--spec', hint: 'Provide a spec file to verify against' }) + '\n');
        exitCode = ExitCode.PARSE_ERROR;
      } else if (verifyMode !== 'agent' && verifyMode !== 'scripted' && verifyMode !== 'auto') {
        process.stdout.write(JSON.stringify({ error: 'invalid_parameter', parameter: '--mode', hint: 'Expected one of: agent, scripted, auto' }) + '\n');
        exitCode = ExitCode.PARSE_ERROR;
      } else {
        const { loadSpec, specToYaml } = await import('../spec/parser.js');
        try {
          const spec = loadSpec(path.resolve(specPath));
          const outputDir = path.resolve(getArg(verifyArgs, '--output') ?? '.specify/verify');
          // Determine target URL: explicit --url, or from spec target
          const targetUrl = url
            ?? ((spec.target.type === 'web' || spec.target.type === 'api') ? spec.target.url : undefined);

          // Seeded fault-scenario injection (resilience regression testing,
          // not simulation). Gated behind SPECIFY_ENABLE_FAULT_INJECTION —
          // when the flag is off, --fault/--fault-seed are parsed but
          // silently ignored (with a warning) so behavior is unchanged.
          // Faults only apply to the agent tier: the scripted tier replays
          // generated tests without the runner's route interception.
          const faultArgs = getAllArgs(verifyArgs, '--fault');
          let faultPlan: import('../agent/fault-injector.js').FaultPlan | undefined;
          if (faultArgs.length > 0) {
            const { faultInjectionEnabled } = await import('../agent/feature-flags.js');
            if (!faultInjectionEnabled()) {
              process.stderr.write(`  ${c.dim('--fault specified but SPECIFY_ENABLE_FAULT_INJECTION is not set; ignoring.')}\n`);
            } else if (verifyMode === 'scripted') {
              process.stderr.write(`  ${c.dim('--fault has no effect in --mode scripted (no agent browser session); ignoring.')}\n`);
            } else {
              const { parseFaultArg } = await import('../agent/fault-injector.js');
              const rules: import('../agent/fault-injector.js').FaultRule[] = [];
              for (const arg of faultArgs) {
                const rule = parseFaultArg(arg);
                if (!rule) {
                  process.stderr.write(`  ${c.dim(`Ignoring malformed --fault "${arg}" (expected <urlPattern>=<500|timeout|abort|empty>)`)}\n`);
                  continue;
                }
                rules.push(rule);
              }
              const seedArg = getArg(verifyArgs, '--fault-seed');
              const seed = seedArg !== undefined ? Number(seedArg) : 1;
              if (rules.length > 0) {
                faultPlan = { seed: Number.isFinite(seed) ? seed : 1, rules };
              }
            }
          }

          if (verifyMode === 'scripted') {
            // ---------------------------------------------------------------
            // Scripted tier (SP-bjr): no agent, no LLM cost. Executes
            // whatever generated suite already exists in `outputDir` (from
            // a previous run) and builds verify-result.json entirely from
            // the replay. Behaviors with no matching test are `skipped`
            // with an "untested:" rationale.
            // ---------------------------------------------------------------
            const { runScriptedForSpec, scriptedModeExitCode } = await import('../agent/scripted-runner.js');
            process.stderr.write(`${c.bold('Verifying (scripted)')} against ${c.cyan(spec.name)}\n`);
            const scripted = await runScriptedForSpec(spec, outputDir);

            if (!scripted.ok) {
              const message = scripted.reason === 'no_tests' ? 'no generated tests found in output dir' : scripted.message;
              process.stderr.write(`Scripted verification failed: ${message}\n`);
              process.stdout.write(JSON.stringify({ error: 'scripted_error', reason: scripted.reason, message }) + '\n');
              exitCode = scripted.reason === 'no_tests' ? ExitCode.ALL_UNTESTED : ExitCode.BROWSER_ERROR;
            } else {
              const failed = scripted.results.filter((r) => r.status === 'failed').length;
              const passedCount = scripted.results.filter((r) => r.status === 'passed').length;
              const skippedCount = scripted.results.filter((r) => r.status === 'skipped').length;
              const pass = scripted.matched > 0 && failed === 0;
              const structuredOutput = {
                spec: { name: spec.name, version: spec.version },
                timestamp: new Date().toISOString(),
                pass,
                summary: { total: scripted.results.length, passed: passedCount, failed, skipped: skippedCount },
                results: scripted.results,
              };

              exitCode = scriptedModeExitCode(scripted.matched, scripted.results);

              process.stderr.write(`Scripted verification complete: ${passedCount} passed, ${failed} failed, ${skippedCount} untested/skipped\n`);
              process.stdout.write(JSON.stringify({ outputDir, pass, structuredOutput }) + '\n');

              const verifyResultPath = path.join(outputDir, 'verify-result.json');
              fs.mkdirSync(outputDir, { recursive: true });
              fs.writeFileSync(verifyResultPath, JSON.stringify({ structuredOutput }, null, 2), 'utf-8');
            }
          } else {
            // ---------------------------------------------------------------
            // agent / auto tiers — both invoke the LLM verify agent. In auto
            // mode a scripted pass runs first; behaviors whose test already
            // passes are kept without agent attention, and only
            // failed/untested behaviors are scoped into the agent's spec. A
            // scripted failure never terminally fails a behavior in auto
            // mode — it escalates to the agent, since stale tests after app
            // changes are expected and the agent can re-verify/regenerate.
            // ---------------------------------------------------------------
            let promptSpec = spec;
            let scriptedPassed: BehaviorResult[] = [];
            let scriptedFullResults: BehaviorResult[] | undefined;
            let autoSkippedAgent = false;

            if (verifyMode === 'auto' && routeAllScripted) {
              // Legacy auto behavior (--route-all-scripted): full scripted
              // suite first, escalate failures/untested. Kept as an A/B
              // lever against the confidence-driven routing below.
              const { runScriptedForSpec, partitionScriptedResults } = await import('../agent/scripted-runner.js');
              process.stderr.write(`${c.dim('Running scripted pass first (--mode auto, --route-all-scripted)...')}\n`);
              const scripted = await runScriptedForSpec(spec, outputDir);
              if (scripted.ok) {
                scriptedFullResults = scripted.results;
                const { passed, escalate } = partitionScriptedResults(scripted.results);
                scriptedPassed = passed;
                process.stderr.write(`${c.dim(`Scripted: ${passed.length} passed (kept), ${escalate.length} escalated to agent`)}\n`);
                if (escalate.length > 0) {
                  const { scopedSpec } = await import('../spec/scope.js');
                  promptSpec = scopedSpec(spec, escalate.map((r) => r.id));
                } else {
                  autoSkippedAgent = true;
                }
              } else {
                process.stderr.write(`${c.dim(`Scripted pass skipped (${scripted.reason}) — running agent on full spec`)}\n`);
              }
            } else if (verifyMode === 'auto') {
              // Confidence-driven routing (SP-9kp): partition behaviors up
              // front via selectTechnique, run the scripted suite scoped
              // (--grep) to just the scripted set, and hand everything else
              // — agent-routed behaviors, scripted failures, and behaviors
              // whose matched test never actually ran — to the agent tier.
              // Every behavior gets SOME technique; routing never drops one.
              const { routeBehaviors, buildScopedGrep } = await import('../agent/technique-selector.js');
              const { ConfidenceStore, defaultConfidencePath } = await import('../agent/confidence-store.js');
              const { runScopedScriptedSuite, testsToBehaviorResults } = await import('../agent/scripted-runner.js');

              const store = new ConfidenceStore(defaultConfidencePath(path.resolve(specPath)));
              const partition = routeBehaviors(spec, (id) => store.get(id), outputDir);
              process.stderr.write(`${c.dim(`Routing (--mode auto): ${partition.scripted.length} scripted, ${partition.agent.length} agent`)}\n`);

              const agentIds = new Set(partition.agent);
              if (partition.scripted.length > 0) {
                const grep = buildScopedGrep(partition.scripted)!;
                const suite = await runScopedScriptedSuite(grep, { cwd: outputDir });
                if (suite.ok) {
                  const byId = new Map(testsToBehaviorResults(suite.tests).map((r) => [r.id, r]));
                  for (const id of partition.scripted) {
                    const r = byId.get(id);
                    if (r && r.status === 'passed') {
                      scriptedPassed.push(r);
                    } else {
                      // Failed, or the scoped run produced no result for
                      // this id (missing/renamed test) — escalate. A
                      // scripted failure is never terminal in auto mode.
                      agentIds.add(id);
                    }
                  }
                } else {
                  process.stderr.write(`${c.dim(`Scoped scripted run skipped (${suite.reason}) — escalating scripted-routed behaviors to agent`)}\n`);
                  for (const id of partition.scripted) agentIds.add(id);
                }
              }

              if (agentIds.size > 0) {
                const { scopedSpec } = await import('../spec/scope.js');
                promptSpec = scopedSpec(spec, [...agentIds]);
                process.stderr.write(`${c.dim(`Scripted: ${scriptedPassed.length} passed (kept), ${agentIds.size} behavior(s) to agent`)}\n`);
              } else {
                autoSkippedAgent = true;
              }
            }

            const { runSpecifyAgent, extractBool } = await import('../agent/sdk-runner.js');
            const { getVerifyPrompt } = await import('../agent/prompts.js');
            const prompt = getVerifyPrompt(specToYaml(promptSpec), faultPlan);

            // --with-context <path/to/run-context.json>: "as-of-that-run"
            // re-verify. Loads a bundle recorded by a prior run and injects
            // its memory/layered-context/skills text verbatim instead of
            // fetching live state, so the rendered system prompt reproduces
            // that run's byte-identically.
            type ContextOverride = { memoryPreamble?: string; layeredContext?: string; skillsText?: string };
            let contextOverride: ContextOverride | undefined;
            if (withContextPath) {
              try {
                const raw = fs.readFileSync(path.resolve(withContextPath), 'utf-8');
                const bundle = JSON.parse(raw) as {
                  memoryPreamble?: string | null;
                  layeredContext?: string | null;
                  skillsText?: string | null;
                };
                contextOverride = {
                  memoryPreamble: bundle.memoryPreamble ?? undefined,
                  layeredContext: bundle.layeredContext ?? undefined,
                  skillsText: bundle.skillsText ?? undefined,
                };
                process.stderr.write(`${c.dim(`Replaying recorded prompt context from ${withContextPath}`)}\n`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`Failed to load --with-context bundle: ${msg}\n`);
              }
            }

            try {
              let structuredOutput: unknown;
              let costUsd = 0;
              let result: unknown;

              if (autoSkippedAgent) {
                process.stderr.write(`${c.dim('All behaviors passed scripted replay — agent not invoked.')}\n`);
                structuredOutput = {
                  spec: { name: spec.name, version: spec.version },
                  timestamp: new Date().toISOString(),
                  pass: true,
                  summary: { total: scriptedPassed.length, passed: scriptedPassed.length, failed: 0, skipped: 0 },
                  results: scriptedPassed,
                };
              } else {
                const { writeBehaviorProgress } = await import('./output.js');
                const areas = promptSpec.areas?.length ?? 0;
                const behaviors = promptSpec.areas?.reduce((n, a) => n + (a.behaviors?.length ?? 0), 0) ?? 0;
                process.stderr.write(`${c.bold('Verifying')} ${c.cyan(targetUrl ?? 'CLI')} against ${c.cyan(spec.name)} (${areas} areas, ${behaviors} behaviors)\n`);
                process.stderr.write(`${c.dim('Launching agent...')}\n`);
                const agentRun = await runSpecifyAgent({
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
                  ...(contextOverride ? { contextOverride } : {}),
                  ...(faultPlan ? { faultPlan } : {}),
                });
                result = agentRun.result;
                costUsd = agentRun.costUsd;
                structuredOutput = agentRun.structuredOutput;

                if (verifyMode === 'auto' && scriptedPassed.length > 0) {
                  const { mergeResultsById } = await import('../spec/scope.js');
                  const agentResults = structuredOutput && typeof structuredOutput === 'object' && Array.isArray((structuredOutput as { results?: unknown }).results)
                    ? (structuredOutput as { results: BehaviorResult[] }).results
                    : [];
                  const merged = mergeResultsById(scriptedPassed, agentResults);
                  const mergedFailed = merged.filter((r) => r.status === 'failed').length;
                  const mergedPassed = merged.filter((r) => r.status === 'passed').length;
                  const mergedSkipped = merged.filter((r) => r.status === 'skipped').length;
                  structuredOutput = {
                    ...(structuredOutput as Record<string, unknown>),
                    results: merged,
                    summary: { total: merged.length, passed: mergedPassed, failed: mergedFailed, skipped: mergedSkipped },
                    pass: mergedFailed === 0,
                  };
                }
              }

              const pass = extractBool(structuredOutput, 'pass');

              // Deterministic failure confirmation: for every AGENT-reported
              // failure (not scripted-replay results, which already carry
              // direct evidence from the run that produced them), run its
              // generated Playwright test (if any) and record whether it
              // independently reproduces the failure. This is added
              // post-hoc — the agent never sees or produces this field —
              // so it can't be fabricated by the LLM.
              const resultsForConfirmation =
                structuredOutput && typeof structuredOutput === 'object' && Array.isArray((structuredOutput as { results?: unknown }).results)
                  ? ((structuredOutput as { results: Array<Record<string, unknown>> }).results)
                  : [];
              const { SCRIPTED_METHOD } = await import('../agent/scripted-runner.js');
              const failedResults = resultsForConfirmation.filter(
                (r) => r.status === 'failed' && typeof r.id === 'string' && r.method !== SCRIPTED_METHOD,
              );
              if (failedResults.length > 0) {
                process.stderr.write(`${c.dim(`Confirming ${failedResults.length} failed behavior(s) against generated tests...`)}\n`);
                const { confirmBehavior } = await import('../agent/test-runner.js');
                for (const r of failedResults) {
                  const behaviorId = r.id as string;
                  try {
                    const confirmTimeoutMs = Number(process.env.SPECIFY_CONFIRM_TIMEOUT_MS) || 60_000;
                    const repro = await confirmBehavior(behaviorId, { cwd: outputDir, timeoutMs: confirmTimeoutMs });
                    if (repro) {
                      r.repro = repro;
                      process.stderr.write(`  ${behaviorId}: ${repro.confirmed ? c.green('confirmed') : c.yellow('unconfirmed')}\n`);
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    r.repro = { confirmed: false, output: `unconfirmable: confirmation run threw: ${msg}` };
                    process.stderr.write(`  ${behaviorId}: ${c.yellow('unconfirmed')} (${msg})\n`);
                  }
                }
              }

              // --cross-check: independently replay the FULL generated
              // suite and diff its outcomes against the agent's verdicts.
              // Report-only — never touches `pass` or `exitCode`. Reuses
              // the scripted pass already run above in auto mode instead
              // of re-running the suite.
              if (crossCheck) {
                process.stderr.write(`${c.dim('Cross-checking agent verdicts against the generated suite...')}\n`);
                let diffResults = scriptedFullResults;
                if (!diffResults) {
                  const { runScriptedForSpec } = await import('../agent/scripted-runner.js');
                  const fresh = await runScriptedForSpec(spec, outputDir);
                  diffResults = fresh.ok ? fresh.results : undefined;
                  if (!fresh.ok) {
                    process.stderr.write(`${c.dim(`Cross-check skipped (${fresh.reason})`)}\n`);
                  }
                }
                if (diffResults) {
                  const { diffCrossCheck } = await import('../agent/scripted-runner.js');
                  const agentResults = resultsForConfirmation as unknown as BehaviorResult[];
                  const crossCheckEntries = diffCrossCheck(agentResults, diffResults);
                  (structuredOutput as Record<string, unknown>).cross_check = crossCheckEntries;
                  const { eventBus } = await import('../agent/event-bus.js');
                  for (const entry of crossCheckEntries) {
                    eventBus.send('crosscheck:result', { ...entry });
                    if (!entry.agreement) {
                      eventBus.send('crosscheck:mismatch', { ...entry });
                      process.stderr.write(`  ${c.yellow('mismatch')} ${entry.id}: agent=${entry.agentStatus} test=${entry.testStatus}\n`);
                    }
                  }
                }
              }

              process.stderr.write(`Verification complete${costUsd ? ` (cost: $${costUsd.toFixed(4)})` : ''}\n`);
              process.stdout.write(JSON.stringify({ result, costUsd, outputDir, pass, structuredOutput }) + '\n');
              // MONITOR_VIOLATION only when every failure was forced by an
              // approved formula's violation (LLM had passed them all); any
              // LLM-reported failure keeps ASSERTION_FAILURE.
              const { isMonitorOnlyFailure } = await import('../monitor/verdict-merge.js');
              exitCode = pass === true
                ? ExitCode.SUCCESS
                : isMonitorOnlyFailure(structuredOutput)
                  ? ExitCode.MONITOR_VIOLATION
                  : ExitCode.ASSERTION_FAILURE;

              const verifyResultPath = path.join(outputDir, 'verify-result.json');
              fs.mkdirSync(outputDir, { recursive: true });
              // cli-target runs have no CaptureCollector, so the runner-recorded
              // trace (cli_run invocations) is saved standalone under
              // <outputDir>/cli/observations.json by CliObservationRecorder.
              // Surface its path in the manifest when present so review tooling
              // can find it the same way it finds the browser-path trace.
              const cliObservationsPath = path.join(outputDir, 'cli', 'observations.json');
              const cliObservationsFile = fs.existsSync(cliObservationsPath)
                ? path.join('cli', 'observations.json')
                : undefined;
              fs.writeFileSync(
                verifyResultPath,
                JSON.stringify({ structuredOutput, ...(cliObservationsFile ? { observationsFile: cliObservationsFile } : {}) }, null, 2),
                'utf-8',
              );

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
          }
        } catch (err) {
          process.stderr.write(`Failed to load spec: ${(err as Error).message}\n`);
          exitCode = ExitCode.PARSE_ERROR;
        }
      }

    } else if (noun === 'deploy') {
      const { deployCommand } = await import('./commands/deploy.js');
      // Normalize --foo=bar to --foo bar so getArg picks it up.
      const deployArgs = rest.flatMap((a) => {
        if (a.startsWith('--') && a.includes('=')) {
          const [k, ...v] = a.split('=');
          return [k, v.join('=')];
        }
        return [a];
      });
      const formatArg = getArg(deployArgs, '--format');
      exitCode = await deployCommand({
        verb,
        format: formatArg === 'text' ? 'text' : 'json',
        preset: deployArgs.find((a) => !a.startsWith('--')),
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
