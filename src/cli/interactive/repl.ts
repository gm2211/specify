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
import type { GapReport } from '../../validation/types.js';
import { ExitCode } from '../exit-codes.js';
import { buildReplCompleter } from './completer.js';

interface ReplState {
  spec: Spec | null;
  specPath: string | null;
  report: GapReport | null;
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
    console.log(`Loaded spec: ${state.spec.name} (${state.spec.pages?.length ?? 0} pages)`);
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

async function handleValidate(state: ReplState): Promise<void> {
  if (!state.spec) {
    console.log('No spec loaded. Use: load spec <path>');
    return;
  }
  if (!state.capturePath) {
    console.log('No capture loaded. Use: load capture <path>');
    return;
  }

  const { loadCaptureData, validate } = await import('../../validation/validator.js');
  const capture = loadCaptureData(state.capturePath);
  const report = validate(state.spec, capture);
  state.report = report;

  const { summary } = report;
  console.log(`Validation: ${summary.passed} passed, ${summary.failed} failed, ${summary.untested} untested (${summary.coverage}% coverage)`);
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
  const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
  const { getVerifyPrompt } = await import('../../agent/prompts.js');
  const prompt = getVerifyPrompt(state.specPath, state.targetUrl);
  const { result, costUsd } = await runSpecifyAgent({
    task: 'verify',
    systemPrompt: prompt,
    userPrompt: `Verify ${state.targetUrl} against the spec at ${state.specPath}.`,
    url: state.targetUrl,
    spec: state.specPath,
    outputDir: '.specify/verify',
    headed: args.includes('--headed'),
  });
  console.log(`\nAgent complete (cost: $${costUsd.toFixed(4)})`);
  console.log(result);
}

function handleShow(args: string[], state: ReplState): void {
  if (!state.report) {
    console.log('No report available. Run "validate" or "run" first.');
    return;
  }

  const target = args[0] ?? 'summary';

  switch (target) {
    case 'summary':
      console.log(`Passed: ${state.report.summary.passed}`);
      console.log(`Failed: ${state.report.summary.failed}`);
      console.log(`Untested: ${state.report.summary.untested}`);
      console.log(`Coverage: ${state.report.summary.coverage}%`);
      break;

    case 'failures': {
      const failures: string[] = [];
      for (const page of state.report.pages) {
        for (const req of page.requests) {
          if (req.status === 'failed') failures.push(`  ${page.pageId}: ${req.method} ${req.urlPattern} -- ${req.reason}`);
        }
      }
      if (failures.length === 0) console.log('No failures.');
      else failures.forEach(f => console.log(f));
      break;
    }

    case 'page': {
      const pageId = args[1];
      if (!pageId) {
        console.log('Usage: show page <pageId|path>');
        return;
      }
      const page = state.report.pages.find(p => p.pageId === pageId || p.path === pageId);
      if (!page) {
        console.log(`Page not found: ${pageId}`);
        return;
      }
      console.log(`Page: ${page.pageId} (${page.path}) -- visited: ${page.visited}`);
      console.log(`  Requests: ${page.requests.length} (${page.requests.filter(r => r.status === 'passed').length} passed, ${page.requests.filter(r => r.status === 'failed').length} failed)`);
      console.log(`  Visual: ${page.visualAssertions.length}`);
      console.log(`  Console: ${page.consoleExpectations.length}`);
      console.log(`  Scenarios: ${page.scenarios.length}`);
      break;
    }

    default:
      console.log('Usage: show summary | show failures | show page <id>');
  }
}

async function handleDiff(args: string[], state: ReplState): Promise<void> {
  if (!state.report) {
    console.log('No current report. Run "validate" or "run" first.');
    return;
  }
  if (args.length < 1) {
    console.log('Usage: diff <path-to-previous-report.json>');
    return;
  }

  const { diffReports, diffToMarkdown } = await import('../../history/diff.js');
  const previous = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf-8')) as GapReport;
  const diff = diffReports(previous, state.report);
  console.log(diffToMarkdown(diff));
}

async function handleRefine(state: ReplState): Promise<void> {
  if (!state.spec || !state.report) {
    console.log('Need both spec and report. Load a spec and run validation first.');
    return;
  }

  const { analyzeGaps, suggestionsToMarkdown } = await import('../../spec/refiner.js');
  const suggestions = analyzeGaps(state.spec, state.report);

  if (suggestions.length === 0) {
    console.log('No refinement suggestions.');
    return;
  }

  console.log(suggestionsToMarkdown(suggestions));
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
  const histDir = path.resolve('.specify', 'history');
  if (!fs.existsSync(histDir)) {
    console.log('No history found. Use --history-dir with validate to save history.');
    return;
  }

  const { createHistoryStore } = await import('../../history/store.js');
  const store = createHistoryStore(histDir);
  const ids = store.list();
  console.log(`History: ${ids.length} run(s)`);
  for (const id of ids.slice(-10)) {
    console.log(`  ${id}`);
  }
}

async function handleStats(): Promise<void> {
  const histDir = path.resolve('.specify', 'history');
  if (!fs.existsSync(histDir)) {
    console.log('No history found.');
    return;
  }

  const { createHistoryStore } = await import('../../history/store.js');
  const { computeStats, statsToMarkdown } = await import('../../history/statistics.js');
  const store = createHistoryStore(histDir);
  const reports = store.list().map(id => store.load(id));
  const stats = computeStats(reports);
  console.log(statsToMarkdown(stats));
}

function printState(state: ReplState): void {
  console.log('');
  if (state.spec) console.log(`  Spec: ${state.spec.name} (${state.specPath})`);
  else console.log('  Spec: (none)');
  if (state.targetUrl) console.log(`  URL: ${state.targetUrl}`);
  if (state.capturePath) console.log(`  Capture: ${state.capturePath}`);
  if (state.report) console.log(`  Report: ${state.report.summary.passed}p/${state.report.summary.failed}f/${state.report.summary.untested}u`);
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
