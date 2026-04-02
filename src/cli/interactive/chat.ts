/**
 * src/cli/interactive/chat.ts — Chat-style REPL for human mode
 *
 * Freeform text interface (like Claude Code) instead of arrow-key menus.
 * Supports natural language commands, slash commands, and interleaved
 * input during agent runs via MessageInjector.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Spec } from '../../spec/types.js';
import { ExitCode } from '../exit-codes.js';
import { c } from '../colors.js';
import { writeBehaviorProgress } from '../output.js';
import { eventBus } from '../../agent/event-bus.js';
import { MessageInjector } from '../../agent/message-injector.js';
import { buildReplCompleter } from './completer.js';

interface ChatState {
  spec: Spec | null;
  specPath: string | null;
  targetUrl: string | null;
  agentResult: unknown;
  running: boolean;
  debug: boolean;
  injector: MessageInjector | null;
}

const COMMANDS = [
  'verify', 'capture', 'load', 'set', 'show', 'lint', 'review',
  'help', 'status', 'exit', 'quit',
];

/** Commands whose last argument is a file/directory path */
const PATH_COMMANDS = new Set(['load', 'review']);

export async function runChat(options: {
  spec?: string;
  url?: string;
  debug?: boolean;
} = {}): Promise<number> {
  const state: ChatState = {
    spec: null,
    specPath: null,
    targetUrl: options.url ?? null,
    agentResult: null,
    running: false,
    debug: options.debug ?? false,
    injector: null,
  };

  // Load initial spec if provided
  if (options.spec) {
    try {
      const { loadSpec } = await import('../../spec/parser.js');
      state.spec = loadSpec(options.spec);
      state.specPath = options.spec;
    } catch (err) {
      process.stderr.write(`${c.red('Failed to load spec:')} ${(err as Error).message}\n`);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${c.cyan('specify')}${c.dim('>')} `,
    completer: buildReplCompleter(COMMANDS, PATH_COMMANDS),
    terminal: process.stdin.isTTY ?? false,
  });

  // History file
  const historyPath = path.resolve('.specify', '.chat_history');
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  } catch { /* ignore */ }

  // Subscribe to agent events for inline display
  const unsubscribe = eventBus.onAny((event) => {
    if (event.type === 'agent:ask_user') {
      // ask_user is handled by the readline prompt directly
    } else if (event.type === 'agent:retry') {
      const { attempt, maxRetries, delayMs } = event.data;
      process.stderr.write(`  ${c.yellow('⟳')} Retrying (${attempt}/${maxRetries}) in ${(delayMs as number) / 1000}s...\n`);
    } else if (event.type === 'agent:started' && state.debug) {
      process.stderr.write(`  ${c.dim('Agent session started')}\n`);
    }
  });

  process.stderr.write(`\n${c.boldCyan('Specify Chat')}\n`);
  process.stderr.write(`${c.dim('Type commands naturally or use /help for available commands.')}\n`);
  printStatus(state);
  process.stderr.write('\n');
  rl.prompt();

  return new Promise<number>((resolve) => {
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      // Save to history
      try {
        fs.appendFileSync(historyPath, trimmed + '\n');
      } catch { /* ignore */ }

      // If agent is running, inject the message
      if (state.running && state.injector) {
        state.injector.inject(trimmed);
        process.stderr.write(`  ${c.dim('→ message injected into agent session')}\n`);
        rl.prompt();
        return;
      }

      try {
        const shouldExit = await handleInput(trimmed, state);
        if (shouldExit) {
          unsubscribe();
          rl.close();
          resolve(ExitCode.SUCCESS);
          return;
        }
      } catch (err) {
        process.stderr.write(`${c.red('Error:')} ${err instanceof Error ? err.message : String(err)}\n`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      unsubscribe();
      resolve(ExitCode.SUCCESS);
    });
  });
}

async function handleInput(input: string, state: ChatState): Promise<boolean> {
  // Normalize: strip leading / for slash commands
  const normalized = input.startsWith('/') ? input.slice(1) : input;
  const parts = normalized.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Exit commands
  if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
    process.stderr.write(`${c.dim('Goodbye.')}\n`);
    return true;
  }

  // Route to handlers
  if (cmd === 'help' || cmd === '?') {
    printHelp();
  } else if (cmd === 'status') {
    printStatus(state);
  } else if (cmd === 'verify' || cmd === 'check' || cmd === 'run') {
    await handleVerify(args, state);
  } else if (cmd === 'capture') {
    await handleCapture(args, state);
  } else if (cmd === 'load') {
    await handleLoad(args, state);
  } else if (cmd === 'set') {
    handleSet(args, state);
  } else if (cmd === 'show') {
    handleShow(state);
  } else if (cmd === 'lint') {
    await handleLint(state);
  } else if (cmd === 'review') {
    await handleReview(args, state);
  } else if (cmd === 'debug') {
    state.debug = !state.debug;
    process.stderr.write(`  Debug mode: ${state.debug ? c.green('on') : c.dim('off')}\n`);
  } else {
    // Try to interpret as natural language
    await handleNaturalLanguage(input, args, state);
  }

  return false;
}

async function handleVerify(args: string[], state: ChatState): Promise<void> {
  // Allow inline URL: "verify https://example.com"
  const inlineUrl = args.find(a => a.startsWith('http'));
  if (inlineUrl) state.targetUrl = inlineUrl;

  // Allow inline spec: "verify --spec path.yaml"
  const specIdx = args.indexOf('--spec');
  if (specIdx >= 0 && args[specIdx + 1]) {
    const specPath = args[specIdx + 1];
    const { loadSpec } = await import('../../spec/parser.js');
    state.spec = loadSpec(specPath);
    state.specPath = specPath;
  }

  if (!state.spec || !state.specPath) {
    process.stderr.write(`${c.yellow('No spec loaded.')} Use: load <path> or verify --spec <path>\n`);
    return;
  }
  if (!state.targetUrl) {
    // Try to get URL from spec
    if (state.spec.target.type === 'web' || state.spec.target.type === 'api') {
      state.targetUrl = (state.spec.target as { url?: string }).url ?? null;
    }
    if (!state.targetUrl) {
      process.stderr.write(`${c.yellow('No target URL.')} Use: set url <url>\n`);
      return;
    }
  }

  process.stderr.write(`\n  ${c.bold('Verifying')} ${c.cyan(state.targetUrl!)} against ${c.cyan(state.spec.name)}\n\n`);

  state.running = true;
  state.agentResult = null;

  const injector = new MessageInjector(
    `Verify ${state.targetUrl} against the behavioral spec.`,
  );
  state.injector = injector;

  try {
    const { runSpecifyAgent, extractBool } = await import('../../agent/sdk-runner.js');
    const { getVerifyPrompt } = await import('../../agent/prompts.js');
    const { specToYaml } = await import('../../spec/parser.js');
    const resolvedSpec = path.resolve(state.specPath);
    const prompt = getVerifyPrompt(specToYaml(state.spec));

    const { costUsd, structuredOutput } = await runSpecifyAgent({
      task: 'verify',
      systemPrompt: prompt,
      userPrompt: `Verify ${state.targetUrl} against the behavioral spec.`,
      url: state.targetUrl!,
      spec: resolvedSpec,
      outputDir: '.specify/verify',
      headed: args.includes('--headed'),
      debug: state.debug,
      onBehaviorProgress: writeBehaviorProgress,
      messageInjector: injector,
    });

    const pass = extractBool(structuredOutput, 'pass');
    state.agentResult = structuredOutput;

    process.stderr.write(`\n  ${pass ? c.boldGreen('PASS') : c.boldRed('FAIL')} (cost: $${costUsd.toFixed(4)})\n`);

    if (structuredOutput && typeof structuredOutput === 'object' && 'summary' in structuredOutput) {
      const summary = (structuredOutput as { summary: { total: number; passed: number; failed: number; skipped: number } }).summary;
      if (summary && typeof summary === 'object') {
        process.stderr.write(`  ${c.green(String(summary.passed))} passed, ${c.red(String(summary.failed))} failed, ${c.dim(String(summary.skipped))} skipped of ${summary.total} total\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`  ${c.red('Verification failed:')} ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    state.running = false;
    state.injector = null;
    injector.close();
  }
}

async function handleCapture(args: string[], state: ChatState): Promise<void> {
  const url = args.find(a => a.startsWith('http')) ?? state.targetUrl;
  if (!url) {
    process.stderr.write(`${c.yellow('Provide a URL:')} capture https://example.com\n`);
    return;
  }

  process.stderr.write(`  ${c.bold('Capturing')} ${c.cyan(url)}...\n`);
  state.running = true;

  try {
    const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
    const { getCapturePrompt } = await import('../../agent/prompts.js');
    const outputDir = path.resolve('.specify/capture');
    const specOutputPath = path.resolve('.specify/spec.yaml');
    const prompt = getCapturePrompt(url, specOutputPath);

    const { costUsd } = await runSpecifyAgent({
      task: 'capture',
      systemPrompt: prompt,
      userPrompt: `Explore and capture ${url}.`,
      url,
      outputDir,
      headed: args.includes('--headed'),
      debug: state.debug,
    });

    process.stderr.write(`  ${c.green('Capture complete')} (cost: $${costUsd.toFixed(4)})\n`);
    process.stderr.write(`  Output: ${outputDir}\n`);
  } catch (err) {
    process.stderr.write(`  ${c.red('Capture failed:')} ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    state.running = false;
  }
}

async function handleLoad(args: string[], state: ChatState): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    // Try auto-discovery
    const { resolveSpecPath } = await import('../spec-finder.js');
    const result = resolveSpecPath(undefined);
    if (result.path) {
      const { loadSpec } = await import('../../spec/parser.js');
      state.spec = loadSpec(result.path);
      state.specPath = result.path;
      process.stderr.write(`  ${c.green('Loaded:')} ${state.spec.name} (${state.specPath})\n`);
    } else {
      process.stderr.write(`${c.yellow('Usage:')} load <path-to-spec.yaml>\n`);
    }
    return;
  }

  try {
    const { loadSpec } = await import('../../spec/parser.js');
    state.spec = loadSpec(filePath);
    state.specPath = filePath;
    process.stderr.write(`  ${c.green('Loaded:')} ${state.spec.name} (${state.spec.areas?.length ?? 0} areas)\n`);
  } catch (err) {
    process.stderr.write(`  ${c.red('Failed:')} ${(err as Error).message}\n`);
  }
}

function handleSet(args: string[], state: ChatState): void {
  if (args.length < 2) {
    process.stderr.write(`${c.yellow('Usage:')} set url <url>\n`);
    return;
  }
  if (args[0] === 'url') {
    state.targetUrl = args[1];
    process.stderr.write(`  ${c.green('URL:')} ${state.targetUrl}\n`);
  } else {
    process.stderr.write(`  Unknown setting: ${args[0]}\n`);
  }
}

function handleShow(state: ChatState): void {
  if (!state.agentResult) {
    process.stderr.write(`  No results yet. Run ${c.cyan('verify')} first.\n`);
    return;
  }

  const ar = state.agentResult as {
    pass?: boolean;
    summary?: { total: number; passed: number; failed: number; skipped: number };
    results?: Array<{ id: string; status: string; description?: string; rationale?: string }>;
  };

  process.stderr.write(`\n  ${ar.pass ? c.boldGreen('PASS') : c.boldRed('FAIL')}\n`);
  if (ar.results?.length) {
    for (const r of ar.results) {
      const icon = r.status === 'passed' ? c.green('✓')
        : r.status === 'failed' ? c.red('✗')
        : c.yellow('-');
      process.stderr.write(`  ${icon} ${r.id}${r.description ? ` — ${r.description}` : ''}\n`);
      if (r.status === 'failed' && r.rationale) {
        process.stderr.write(`    ${c.dim(r.rationale)}\n`);
      }
    }
  }
  process.stderr.write('\n');
}

async function handleLint(state: ChatState): Promise<void> {
  if (!state.spec || !state.specPath) {
    process.stderr.write(`  No spec loaded.\n`);
    return;
  }
  const { lintRaw } = await import('../../spec/lint.js');
  const content = fs.readFileSync(path.resolve(state.specPath), 'utf-8');
  const result = lintRaw(content);
  if (result.valid) {
    process.stderr.write(`  ${c.green('✓')} Spec is valid\n`);
  } else {
    process.stderr.write(`  ${c.red('✗')} Spec has issues:\n`);
    for (const err of result.errors ?? []) {
      process.stderr.write(`    ${c.red('•')} ${err}\n`);
    }
  }
}

async function handleReview(args: string[], state: ChatState): Promise<void> {
  if (!state.specPath) {
    process.stderr.write(`  No spec loaded.\n`);
    return;
  }
  const port = parseInt(args.find(a => /^\d+$/.test(a)) ?? '3456');
  const { startReviewServer } = await import('../../review/server.js');
  await startReviewServer({
    specPath: state.specPath,
    port,
    open: true,
  });
}

async function handleNaturalLanguage(input: string, _args: string[], state: ChatState): Promise<void> {
  const lower = input.toLowerCase();

  // Simple keyword matching for common intents
  if (lower.includes('verify') || lower.includes('check') || lower.includes('test against')) {
    const urlMatch = input.match(/(https?:\/\/\S+)/);
    const args = urlMatch ? [urlMatch[1]] : [];
    await handleVerify(args, state);
  } else if (lower.includes('capture') || lower.includes('explore')) {
    const urlMatch = input.match(/(https?:\/\/\S+)/);
    const args = urlMatch ? [urlMatch[1]] : [];
    await handleCapture(args, state);
  } else if (lower.includes('load') || lower.includes('open')) {
    const fileMatch = input.match(/(\S+\.(ya?ml|json))/);
    await handleLoad(fileMatch ? [fileMatch[1]] : [], state);
  } else if (lower.includes('status') || lower.includes('what') && lower.includes('loaded')) {
    printStatus(state);
  } else {
    process.stderr.write(`  ${c.dim("I don't understand that. Type")} ${c.cyan('/help')} ${c.dim('for commands.')}\n`);
  }
}

function printStatus(state: ChatState): void {
  process.stderr.write('\n');
  if (state.spec) {
    process.stderr.write(`  ${c.bold('Spec:')} ${state.spec.name} ${c.dim(`(${state.specPath})`)}\n`);
    process.stderr.write(`  ${c.bold('Areas:')} ${state.spec.areas?.length ?? 0}\n`);
  } else {
    process.stderr.write(`  ${c.dim('No spec loaded')}\n`);
  }
  if (state.targetUrl) {
    process.stderr.write(`  ${c.bold('URL:')} ${state.targetUrl}\n`);
  }
  if (state.agentResult) {
    const ar = state.agentResult as { pass?: boolean };
    process.stderr.write(`  ${c.bold('Last result:')} ${ar.pass ? c.green('PASS') : c.red('FAIL')}\n`);
  }
  process.stderr.write(`  ${c.bold('Debug:')} ${state.debug ? c.green('on') : c.dim('off')}\n`);
}

function printHelp(): void {
  process.stderr.write(`
${c.boldCyan('Specify Chat Commands')}

  ${c.cyan('verify')} [url] [--spec path] [--headed]   Verify spec against app
  ${c.cyan('capture')} <url> [--headed]                 Capture app behavior
  ${c.cyan('load')} <spec.yaml>                         Load a spec file
  ${c.cyan('set url')} <url>                            Set target URL
  ${c.cyan('show')}                                     Show last verification results
  ${c.cyan('lint')}                                     Lint loaded spec
  ${c.cyan('review')} [port]                            Open review web UI
  ${c.cyan('status')}                                   Show current session state
  ${c.cyan('debug')}                                    Toggle debug mode
  ${c.cyan('help')}                                     Show this help
  ${c.cyan('exit')}                                     Exit

${c.dim('You can also type naturally: "verify localhost:3000" or "check my spec"')}
${c.dim('While an agent is running, type to inject messages into the session.')}
`);
}
