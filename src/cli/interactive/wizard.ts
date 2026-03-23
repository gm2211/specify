/**
 * src/cli/interactive/wizard.ts — Interactive guide for Specify
 *
 * Context-aware wizard that detects project state (existing specs, captures,
 * reports, URLs) and guides the user through the appropriate workflow.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Spec } from '../../spec/types.js';
import { specToYaml } from '../../spec/parser.js';
import { completePath } from './completer.js';
import { ExitCode } from '../exit-codes.js';

// ---------------------------------------------------------------------------
// Project state detection
// ---------------------------------------------------------------------------

interface ProjectState {
  specs: string[];
  captures: string[];
  reports: string[];
  historyDir: string | null;
  agentRuns: string[];
  e2eTestDirs: string[];
  e2eFramework: 'playwright' | 'cypress' | 'unknown' | null;
}

function detectProjectState(): ProjectState {
  const cwd = process.cwd();

  // Find spec files
  const specs: string[] = [];
  for (const pattern of ['spec.yaml', 'spec.yml', 'spec.json', '*.spec.yaml', '*.spec.yml']) {
    const glob = pattern.replace('*', '');
    try {
      const files = fs.readdirSync(cwd).filter(f =>
        pattern.includes('*') ? f.endsWith(glob) : f === pattern
      );
      specs.push(...files);
    } catch { /* ignore */ }
  }

  // All runtime data lives under .specify/
  const specifyDir = path.join(cwd, '.specify');

  // Find capture directories (contain traffic.json)
  const captures: string[] = [];
  // Check .specify/capture/ (agent default), .specify/captures/ (legacy), and captures/ (legacy)
  for (const capturesBase of [path.join(specifyDir, 'capture'), path.join(specifyDir, 'captures'), path.join(cwd, 'captures')]) {
    if (fs.existsSync(capturesBase)) {
      try {
        const subdirs = fs.readdirSync(capturesBase).filter(d => {
          const full = path.join(capturesBase, d);
          return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'traffic.json'));
        });
        captures.push(...subdirs.map(d => path.relative(cwd, path.join(capturesBase, d))));
      } catch { /* ignore */ }
    }
  }
  // Also check cwd for traffic.json
  if (fs.existsSync(path.join(cwd, 'traffic.json'))) {
    captures.push('.');
  }

  // Find report files
  const reports: string[] = [];
  try {
    const files = fs.readdirSync(cwd).filter(f =>
      f.endsWith('.json') && (f.includes('report') || f.includes('gap'))
    );
    reports.push(...files);
  } catch { /* ignore */ }

  // Check for agent-runs directory (.specify/agent-runs/ or legacy agent-runs/)
  const agentRuns: string[] = [];
  for (const agentRunsBase of [path.join(specifyDir, 'agent-runs'), path.join(cwd, 'agent-runs')]) {
    if (fs.existsSync(agentRunsBase)) {
      try {
        const subdirs = fs.readdirSync(agentRunsBase)
          .filter(d => fs.statSync(path.join(agentRunsBase, d)).isDirectory())
          .sort()
          .reverse()
          .slice(0, 5);
        agentRuns.push(...subdirs.map(d => path.relative(cwd, path.join(agentRunsBase, d))));
      } catch { /* ignore */ }
    }
  }

  // Check for history directory
  const historyDir = fs.existsSync(path.join(specifyDir, 'history'))
    ? '.specify/history'
    : null;

  // Detect e2e test directories and framework
  const e2eTestDirs: string[] = [];
  let e2eFramework: 'playwright' | 'cypress' | 'unknown' | null = null;

  // Check common e2e test locations
  const testDirCandidates = ['tests', 'e2e', 'test', 'cypress/e2e', 'cypress/integration', '__tests__'];
  for (const dir of testDirCandidates) {
    const full = path.join(cwd, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      e2eTestDirs.push(dir);
    }
  }

  // Detect framework from config files
  if (fs.existsSync(path.join(cwd, 'playwright.config.ts')) || fs.existsSync(path.join(cwd, 'playwright.config.js'))) {
    e2eFramework = 'playwright';
  } else if (fs.existsSync(path.join(cwd, 'cypress.config.ts')) || fs.existsSync(path.join(cwd, 'cypress.config.js')) || fs.existsSync(path.join(cwd, 'cypress.json'))) {
    e2eFramework = 'cypress';
  }

  return { specs, captures, reports, historyDir, agentRuns, e2eTestDirs, e2eFramework };
}

// ---------------------------------------------------------------------------
// Arrow-key menu selector
// ---------------------------------------------------------------------------

function arrowSelect(options: string[], title: string): Promise<number> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Fallback for non-TTY: just pick first
      resolve(0);
      return;
    }

    let selected = 0;
    let firstRender = true;

    // Cursor ends on the hint line (no trailing \r\n), so we're
    // options.length + 1 lines below the first option line.
    const totalLines = options.length + 1;

    const render = () => {
      if (!firstRender) {
        // Move cursor up to the first option line and carriage return
        process.stderr.write(`\x1b[${totalLines}F`);
      }
      for (let i = 0; i < options.length; i++) {
        const prefix = i === selected ? '\x1b[36m  > ' : '    ';
        const suffix = i === selected ? '\x1b[0m' : '';
        process.stderr.write(`\x1b[2K${prefix}${options[i]}${suffix}\r\n`);
      }
      process.stderr.write(`\x1b[2K\r\n`);
      process.stderr.write(`\x1b[2K  \x1b[2m(arrow keys to move, enter to select)\x1b[0m`);
      firstRender = false;
    };

    process.stderr.write(`\n  ${title}\n\n`);
    render();

    const wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (key: Buffer) => {
      const s = key.toString();

      // Up arrow or k
      if (s === '\x1b[A' || s === 'k') {
        selected = (selected - 1 + options.length) % options.length;
        render();
      }
      // Down arrow or j
      else if (s === '\x1b[B' || s === 'j') {
        selected = (selected + 1) % options.length;
        render();
      }
      // Enter
      else if (s === '\r' || s === '\n') {
        cleanup();
        process.stderr.write(`\x1b[2K\r\n`);
        resolve(selected);
      }
      // Ctrl-C
      else if (s === '\x03') {
        cleanup();
        process.stderr.write('\n');
        process.exit(0);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };

    process.stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createPromptHelpers(rl: readline.Interface) {
  const ask = (question: string, defaultVal?: string): Promise<string> =>
    new Promise((resolve) => {
      const suffix = defaultVal ? ` [${defaultVal}]` : '';
      rl.question(`  ${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultVal || '');
      });
    });

  /**
   * Ask for a file or directory path with tab completion.
   * Spawns a temporary readline with a path completer, then restores the original.
   */
  const askPath = (question: string, defaultVal?: string): Promise<string> =>
    new Promise((resolve) => {
      // Pause the main rl so it doesn't fight for stdin
      rl.pause();

      const pathRl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: process.stdin.isTTY ?? false,
        completer: (line: string) => completePath(line),
      });

      const suffix = defaultVal ? ` [${defaultVal}]` : '';
      pathRl.question(`  ${question}${suffix}: `, (answer) => {
        pathRl.close();
        rl.resume();
        resolve(answer.trim() || defaultVal || '');
      });
    });

  const confirm = (question: string, defaultYes = true): Promise<boolean> =>
    new Promise((resolve) => {
      const hint = defaultYes ? '[Y/n]' : '[y/N]';
      rl.question(`  ${question} ${hint} `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === '') resolve(defaultYes);
        else resolve(a === 'y' || a === 'yes');
      });
    });

  const choose = (question: string, options: string[]): Promise<number> =>
    new Promise((resolve) => {
      // Pause rl so arrow-key selector can take over stdin
      rl.pause();
      arrowSelect(options, question).then((idx) => {
        rl.resume();
        resolve(idx);
      });
    });

  return { ask, askPath, confirm, choose };
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export async function runWizard(options: { fromCapture?: string; action?: string; subAction?: string; spec?: string } = {}): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  const { ask, askPath, confirm, choose } = createPromptHelpers(rl);

  try {
    console.error('');
    console.error('  Specify — Interactive Guide');
    console.error('  ──────────────────────────');

    // Detect project state
    const state = detectProjectState();

    // Override spec if --spec was passed
    if (options.spec) {
      state.specs = [options.spec];
    }

    // Show what we found
    console.error('');
    if (state.specs.length > 0) {
      console.error(`  Found spec(s):    ${state.specs.join(', ')}`);
    }
    if (state.captures.length > 0) {
      console.error(`  Found capture(s): ${state.captures.length} session(s)`);
    }
    if (state.reports.length > 0) {
      console.error(`  Found report(s):  ${state.reports.join(', ')}`);
    }
    if (state.agentRuns.length > 0) {
      console.error(`  Found agent runs: ${state.agentRuns.length} run(s)`);
    }
    if (state.historyDir) {
      console.error(`  Found history:    ${state.historyDir}`);
    }
    if (state.e2eTestDirs.length > 0) {
      console.error(`  Found e2e tests: ${state.e2eTestDirs.join(', ')}${state.e2eFramework ? ` (${state.e2eFramework})` : ''}`);
    }
    if (state.specs.length === 0 && state.captures.length === 0) {
      console.error('  No existing specs or captures found.');
    }

    // Lifecycle-aligned menu — task-oriented labels
    const menuOptions: { label: string; action: string }[] = [
      { label: 'Create   — start a new spec from scratch', action: 'create' },
      { label: 'Capture  — derive a spec from a running app or existing tests', action: 'capture' },
      { label: 'Review   — read the spec in a browser', action: 'review' },
      { label: 'Verify   — check that the implementation matches the spec', action: 'verify' },
    ];

    let action: string;

    if (options.action) {
      // Direct path access: `specify human verify`, `specify human capture`, etc.
      const match = menuOptions.find(o => o.action === options.action);
      if (match) {
        action = match.action;
        console.error(`\n  → ${match.label}\n`);
      } else {
        console.error(`\n  Unknown action: ${options.action}`);
        console.error('  Available: create, capture, review, verify\n');
        rl.close();
        return ExitCode.PARSE_ERROR;
      }
    } else {
      // Interactive menu
      rl.pause();
      const choice = await arrowSelect(menuOptions.map(o => o.label), 'What would you like to do?');
      rl.resume();
      action = menuOptions[choice].action;
    }

    let exitCode: number;

    const prompts = { ask, askPath, confirm, choose };

    switch (action) {
      case 'create':
        exitCode = await flowCreate(prompts, options.fromCapture);
        break;
      case 'capture':
        exitCode = await flowCaptureMenu(state, prompts, options.subAction);
        break;
      case 'review':
        exitCode = await flowReview(state, prompts);
        break;
      case 'verify':
        exitCode = await flowVerifyMenu(state, prompts, options.subAction);
        break;
      default:
        exitCode = ExitCode.SUCCESS;
    }

    rl.close();
    return exitCode;
  } catch (err) {
    rl.close();
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      return ExitCode.SUCCESS;
    }
    console.error(`\n  Error: ${err instanceof Error ? err.message : String(err)}`);
    return ExitCode.PARSE_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Flow: Validate
// ---------------------------------------------------------------------------

type Prompts = ReturnType<typeof createPromptHelpers>;
type PromptFns = { ask: Prompts['ask']; askPath: Prompts['askPath']; confirm: Prompts['confirm']; choose: Prompts['choose'] };

async function pickSpec(state: ProjectState, { askPath, choose }: PromptFns): Promise<string> {
  if (state.specs.length === 1) {
    console.error(`\n  Using spec: ${state.specs[0]}`);
    return state.specs[0];
  } else if (state.specs.length > 1) {
    const idx = await choose('Which spec?', state.specs);
    return state.specs[idx];
  } else {
    return await askPath('Path to spec file');
  }
}

async function pickCapture(state: ProjectState, { askPath, choose }: PromptFns): Promise<string> {
  if (state.captures.length === 1) {
    console.error(`  Using capture: ${state.captures[0]}`);
    return state.captures[0];
  } else if (state.captures.length > 1) {
    const idx = await choose('Which capture?', state.captures);
    return state.captures[idx];
  } else {
    return await askPath('Path to capture directory');
  }
}

async function flowValidate(_state: ProjectState, _prompts: PromptFns): Promise<number> {
  console.error('\n  Passive data validation has been removed. Use "verify --url" for agent-driven verification.\n');
  return ExitCode.PARSE_ERROR;
}

// ---------------------------------------------------------------------------
// Flow: Agent run
// ---------------------------------------------------------------------------

async function flowAgent(state: ProjectState, { ask, askPath, choose }: PromptFns): Promise<number> {
  const specPath = await pickSpec(state, { askPath, choose } as PromptFns);

  const url = await ask('Target URL', 'http://localhost:3000');
  const headed = await ask('Browser mode', 'headless');

  console.error('\n  Launching agent...\n');

  const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
  const { getVerifyPrompt } = await import('../../agent/prompts.js');
  const { loadSpec, specToYaml } = await import('../../spec/parser.js');
  const resolvedSpec = path.resolve(specPath);
  const spec = loadSpec(resolvedSpec);
  const prompt = getVerifyPrompt(specToYaml(spec));
  const { result, costUsd, structuredOutput } = await runSpecifyAgent({
    task: 'verify',
    systemPrompt: prompt,
    userPrompt: `Verify ${url} against the behavioral spec.`,
    url,
    spec: resolvedSpec,
    outputDir: '.specify/verify',
    headed: headed === 'headed',
  });

  const { extractBool } = await import('../../agent/sdk-runner.js');
  const pass = extractBool(structuredOutput, 'pass');

  console.error('');
  console.error(`  Agent complete (cost: $${costUsd.toFixed(4)})`);
  if (pass !== null) {
    console.error(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
  }
  console.error(`  ${result}`);

  return pass === true ? ExitCode.SUCCESS : ExitCode.ASSERTION_FAILURE;
}


// ---------------------------------------------------------------------------
// Flow: Generate
// ---------------------------------------------------------------------------

async function flowGenerate(state: ProjectState, { ask, askPath, choose }: PromptFns): Promise<number> {
  const capturePath = await pickCapture(state, { askPath, choose } as PromptFns);

  const specName = await ask('Spec name', 'Generated Spec');
  const outputPath = await askPath('Output file', 'spec.yaml');

  console.error('\n  Generating spec...\n');

  const { generateSpec } = await import('../../spec/generator.js');
  const spec = generateSpec({
    inputDir: path.resolve(capturePath),
    specName,
  });

  const yaml = specToYaml(spec);

  const areaCount = spec.areas?.length ?? 0;
  console.error(`  Areas: ${areaCount}`);

  fs.writeFileSync(path.resolve(outputPath), yaml, 'utf-8');
  console.error(`\n  Spec written to: ${outputPath}`);

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Flow: Create new spec
// ---------------------------------------------------------------------------

async function flowCreate(
  { ask, askPath, confirm }: PromptFns,
  _fromCapture?: string,
): Promise<number> {
  console.error('');
  const name = await ask('App name', 'my-app');
  const baseUrl = await ask('Base URL', 'http://localhost:3000');
  const description = await ask('Description', `Spec for ${name}`);
  const outputPath = await askPath('Output file', 'spec.yaml');

  const spec: Spec = {
    version: '2',
    name,
    description,
    target: { type: 'web', url: baseUrl },
    areas: [],
  };

  const yaml = specToYaml(spec);
  console.error('\n--- Preview ---');
  console.error(yaml);
  console.error('--- End ---\n');

  if (await confirm(`Write to ${outputPath}?`)) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), yaml, 'utf-8');
    console.error(`\n  Spec written to: ${outputPath}`);
  }

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Flow: Capture (sub-menu)
// ---------------------------------------------------------------------------

async function flowCaptureMenu(state: ProjectState, prompts: PromptFns, subAction?: string): Promise<number> {
  const { choose } = prompts;

  const options = [
    { label: 'From a live URL', action: 'live' },
    { label: 'Generate spec from capture data', action: 'generate' },
  ];

  let action: string;
  if (subAction) {
    const match = options.find(o => o.action === subAction);
    action = match ? match.action : subAction;
  } else {
    const idx = await choose('Capture from where?', options.map(o => o.label));
    action = options[idx].action;
  }

  switch (action) {
    case 'live':
      return await flowCaptureLive(prompts);
    case 'generate':
      return await flowGenerate(state, prompts);
    default:
      return ExitCode.SUCCESS;
  }
}

async function flowCaptureLive({ ask, askPath }: PromptFns): Promise<number> {
  const url = await ask('URL to capture', 'http://localhost:3000');
  const outputDir = await askPath('Output directory', './captures/latest');

  try {
    new URL(url);
  } catch {
    console.error(`  Invalid URL: ${url}`);
    return ExitCode.PARSE_ERROR;
  }

  console.error('\n  Launching agent capture...\n');

  const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
  const { getCapturePrompt } = await import('../../agent/prompts.js');
  const resolvedOutputDir = path.resolve(outputDir);
  const specOutputPath = path.resolve(path.join(path.dirname(resolvedOutputDir), 'spec.yaml'));
  const prompt = getCapturePrompt(url, specOutputPath);

  try {
    const { costUsd } = await runSpecifyAgent({
      task: 'capture',
      systemPrompt: prompt,
      userPrompt: `Explore ${url} and generate a comprehensive behavioral spec.`,
      url,
      outputDir: resolvedOutputDir,
      specOutput: specOutputPath,
      specName: new URL(url).hostname,
    });
    console.error(`\n  Capture complete (cost: $${costUsd.toFixed(4)})`);

    if (!fs.existsSync(specOutputPath)) {
      console.error(`  Warning: agent did not write spec file at ${specOutputPath}`);
      return ExitCode.PARSE_ERROR;
    }
    try {
      const { loadSpec } = await import('../../spec/parser.js');
      const spec = loadSpec(specOutputPath);
      console.error(`  Spec validated: ${specOutputPath} (${spec.areas?.length ?? 0} areas)`);
      return ExitCode.SUCCESS;
    } catch (parseErr) {
      console.error(`  Warning: agent wrote invalid spec: ${(parseErr as Error).message}`);
      return ExitCode.PARSE_ERROR;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Agent capture failed: ${msg}`);
    return ExitCode.BROWSER_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Flow: Review
// ---------------------------------------------------------------------------

async function flowReview(state: ProjectState, prompts: PromptFns): Promise<number> {
  const specPath = await pickSpec(state, prompts);

  console.error('\n  Generating review...\n');

  const { review: reviewCmd } = await import('../commands/review.js');
  return await reviewCmd(
    { spec: specPath, noOpen: false },
    { outputFormat: 'text', quiet: false },
  );
}

// ---------------------------------------------------------------------------
// Flow: Verify (sub-menu)
// ---------------------------------------------------------------------------

async function flowVerifyMenu(state: ProjectState, prompts: PromptFns, subAction?: string): Promise<number> {
  // Agent verification is the only mode now
  if (subAction && subAction !== 'agent') {
    console.error(`\n  Unknown verify sub-action: ${subAction}. Only agent verification is available.\n`);
    return ExitCode.PARSE_ERROR;
  }
  return await flowAgent(state, prompts);
}

