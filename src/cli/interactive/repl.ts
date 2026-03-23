/**
 * src/cli/interactive/repl.ts — REPL shell for iterative spec development
 *
 * Persistent interactive session with command completion, session state,
 * and integration with all Specify operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Spec } from '../../spec/types.js';
import { ExitCode } from '../exit-codes.js';
import { buildReplCompleter } from './completer.js';

interface ReplState {
  spec: Spec | null;
  specPath: string | null;
  report: unknown;
  agentResult: unknown;
  capturePath: string | null;
  targetUrl: string | null;
}

const REPL_COMMANDS = [
  'load', 'set', 'validate', 'run', 'show', 'diff', 'refine',
  'apply', 'save', 'history', 'stats', 'help', 'exit', 'quit',
];

/** Commands whose last argument is a file/directory path */
const PATH_COMMANDS = new Set(['diff']);

export async function runRepl(options: { spec?: string; url?: string } = {}): Promise<number> {
  const state: ReplState = {
    spec: null,
    specPath: null,
    report: null,
    agentResult: null,
    capturePath: null,
    targetUrl: options.url ?? null,
  };

  // Load initial spec if provided
  if (options.spec) {
    try {
      const { loadSpec } = await import('../../spec/parser.js');
      state.spec = loadSpec(options.spec);
      state.specPath = options.spec;
    } catch (err) {
      console.error(`Failed to load spec: ${(err as Error).message}`);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'specify> ',
    completer: buildReplCompleter(REPL_COMMANDS, PATH_COMMANDS),
    terminal: process.stdin.isTTY ?? false,
  });

  // History file
  const historyPath = path.resolve('.specify', '.repl_history');
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  } catch { /* ignore */ }

  console.error('Specify REPL -- type "help" for commands, "exit" to quit');
  printState(state);
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

      try {
        await handleCommand(trimmed, state);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        rl.close();
        resolve(ExitCode.SUCCESS);
        return;
      }

      rl.prompt();
    });

    rl.on('close', () => {
      resolve(ExitCode.SUCCESS);
    });
  });
}

async function handleCommand(input: string, state: ReplState): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case 'load':
      await handleLoad(args, state);
      break;

    case 'set':
      handleSet(args, state);
      break;

    case 'validate':
      await handleValidate(state);
      break;

    case 'run':
      await handleRun(args, state);
      break;

    case 'show':
      handleShow(args, state);
      break;

    case 'diff':
      await handleDiff(args, state);
      break;

    case 'refine':
      await handleRefine(state);
      break;

    case 'save':
      await handleSave(args, state);
      break;

    case 'history':
      await handleHistory();
      break;

    case 'stats':
      await handleStats();
      break;

    case 'help':
      printHelp();
      break;

    case 'exit':
    case 'quit':
      console.log('Goodbye.');
      break;

    default:
      console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
  }
}

async function handleLoad(args: string[], state: ReplState): Promise<void> {
  if (args.length < 2) {
    console.log('Usage: load spec <path> | load capture <path>');
    return;
  }

  const [type, filePath] = args;

  if (type === 'spec') {
    const { loadSpec } = await import('../../spec/parser.js');
    state.spec = loadSpec(filePath);
    state.specPath = filePath;
    console.log(`Loaded spec: ${state.spec.name} (${state.spec.areas?.length ?? 0} areas)`);
  } else if (type === 'capture') {
    state.capturePath = filePath;
    console.log(`Capture path set: ${filePath}`);
  } else {
    console.log(`Unknown load target: ${type}`);
  }
}

function handleSet(args: string[], state: ReplState): void {
  if (args.length < 2) {
    console.log('Usage: set url <url>');
    return;
  }

  if (args[0] === 'url') {
    state.targetUrl = args[1];
    console.log(`Target URL set: ${state.targetUrl}`);
  } else {
    console.log(`Unknown setting: ${args[0]}`);
  }
}

async function handleValidate(_state: ReplState): Promise<void> {
  console.log('Passive data validation has been removed. Use "run" for agent-driven verification.');
}

async function handleRun(args: string[], state: ReplState): Promise<void> {
  if (!state.spec || !state.specPath) {
    console.log('No spec loaded. Use: load spec <path>');
    return;
  }
  if (!state.targetUrl) {
    console.log('No target URL set. Use: set url <url>');
    return;
  }

  console.log('Running agent...');
  state.report = null;
  state.agentResult = null;
  const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
  const { getVerifyPrompt } = await import('../../agent/prompts.js');
  const { loadSpec, specToYaml } = await import('../../spec/parser.js');
  const resolvedSpec = path.resolve(state.specPath);
  const spec = loadSpec(resolvedSpec);
  const prompt = getVerifyPrompt(specToYaml(spec));
  const { result, costUsd, structuredOutput } = await runSpecifyAgent({
    task: 'verify',
    systemPrompt: prompt,
    userPrompt: `Verify ${state.targetUrl} against the behavioral spec.`,
    url: state.targetUrl,
    spec: resolvedSpec,
    outputDir: '.specify/verify',
    headed: args.includes('--headed'),
  });
  const { extractBool } = await import('../../agent/sdk-runner.js');
  const pass = extractBool(structuredOutput, 'pass');
  state.agentResult = structuredOutput;
  console.log(`\nAgent complete (cost: $${costUsd.toFixed(4)})`);
  if (pass !== null) {
    const summary = structuredOutput && typeof structuredOutput === 'object' && 'summary' in structuredOutput
      ? (structuredOutput as { summary: string }).summary : '';
    console.log(`Result: ${pass ? 'PASS' : 'FAIL'}${summary ? ` — ${summary}` : ''}`);
  }
  console.log(result);
}

function handleShow(_args: string[], state: ReplState): void {
  if (!state.agentResult) {
    console.log('No report available. Run "run" first.');
    return;
  }

  const ar = state.agentResult as { pass?: boolean; summary?: string; results?: { id: string; pass: boolean; evidence: string }[] };
  console.log(`Result: ${ar.pass ? 'PASS' : 'FAIL'}`);
  if (ar.summary) console.log(`Summary: ${ar.summary}`);
  if (ar.results?.length) {
    for (const r of ar.results) {
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.id}: ${r.evidence}`);
    }
  }
}

async function handleDiff(_args: string[], _state: ReplState): Promise<void> {
  console.log('Report diffing has been removed.');
}

async function handleRefine(state: ReplState): Promise<void> {
  if (!state.spec || !state.report) {
    console.log('Need both spec and report. Load a spec and run validation first.');
    return;
  }

  console.log('Spec refinement has been removed. Edit the spec directly to add areas and behaviors.');
}

async function handleSave(args: string[], state: ReplState): Promise<void> {
  if (args.length < 2) {
    console.log('Usage: save spec <path>');
    return;
  }

  if (args[0] === 'spec' && state.spec) {
    const { specToYaml } = await import('../../spec/parser.js');
    const yaml = specToYaml(state.spec);
    fs.writeFileSync(path.resolve(args[1]), yaml, 'utf-8');
    console.log(`Spec saved to: ${args[1]}`);
  } else {
    console.log('No spec to save. Load one first.');
  }
}

async function handleHistory(): Promise<void> {
  console.log('History tracking has been removed.');
}

async function handleStats(): Promise<void> {
  console.log('Statistics have been removed.');
}

function printState(state: ReplState): void {
  console.log('');
  if (state.spec) console.log(`  Spec: ${state.spec.name} (${state.specPath})`);
  else console.log('  Spec: (none)');
  if (state.targetUrl) console.log(`  URL: ${state.targetUrl}`);
  if (state.capturePath) console.log(`  Capture: ${state.capturePath}`);
  if (state.agentResult) console.log(`  Agent result: available`);
  console.log('');
}

function printHelp(): void {
  console.log(
`Commands:
  load spec <path>          Load a spec into session
  load capture <path>       Load capture data
  set url <url>             Set target URL
  validate                  Run validation (uses loaded spec + capture)
  run [--headed]            Run agent (uses loaded spec + url)
  show summary              Show last report summary
  show page <id|path>       Show results for specific page
  show failures             Show only failing assertions
  diff <report.json>        Diff against previous report
  refine                    Generate refinement suggestions
  save spec <path>          Save current spec
  history                   Show run history
  stats                     Show statistical confidence
  help                      Show this help
  exit                      Exit REPL`
  );
}
