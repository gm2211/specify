/**
 * src/cli/interactive/wizard.ts — Interactive guide for Specify
 *
 * Context-aware wizard that detects project state (existing specs, captures,
 * reports, URLs) and guides the user through the appropriate workflow.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { Spec, PageSpec } from '../../spec/types.js';
import { specToYaml } from '../../spec/parser.js';
import { discoverPages, type DiscoveredPage } from './crawler.js';
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

async function flowValidate(state: ProjectState, { askPath, choose }: PromptFns): Promise<number> {
  const specPath = await pickSpec(state, { askPath, choose } as PromptFns);
  const capturePath = await pickCapture(state, { askPath, choose } as PromptFns);

  const outputDir = await askPath('Output directory (empty to skip)', '');

  console.error('\n  Running validation...\n');

  const { loadSpec } = await import('../../spec/parser.js');
  const { loadCaptureData, validate } = await import('../../validation/validator.js');
  const { toMarkdown, toJson } = await import('../../validation/reporter.js');

  const spec = loadSpec(specPath);
  const capture = loadCaptureData(capturePath);
  const report = validate(spec, capture);

  // Print summary
  const { summary } = report;
  console.error(`  Passed:   ${summary.passed}`);
  console.error(`  Failed:   ${summary.failed}`);
  console.error(`  Untested: ${summary.untested}`);
  console.error(`  Coverage: ${summary.coverage}%`);

  // Write files
  if (outputDir) {
    const dir = path.resolve(outputDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gap-report.json'), toJson(report), 'utf-8');
    fs.writeFileSync(path.join(dir, 'gap-report.md'), toMarkdown(report), 'utf-8');
    console.error(`\n  Reports written to: ${dir}`);
  }

  // Output JSON to stdout
  process.stdout.write(toJson(report) + '\n');

  return summary.failed > 0 ? ExitCode.ASSERTION_FAILURE : ExitCode.SUCCESS;
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
  const resolvedSpec = path.resolve(specPath);
  const prompt = getVerifyPrompt(resolvedSpec, url);
  const { result, costUsd, structuredOutput } = await runSpecifyAgent({
    task: 'verify',
    systemPrompt: prompt,
    userPrompt: `Verify ${url} against the spec at ${resolvedSpec}.`,
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
// Flow: Diff
// ---------------------------------------------------------------------------

async function flowDiff(state: ProjectState, { askPath, choose }: PromptFns): Promise<number> {
  let reportA: string;
  let reportB: string;

  if (state.reports.length >= 2) {
    console.error('\n  Select baseline report (older):');
    const idxA = await choose('Baseline report?', state.reports);
    reportA = state.reports[idxA];
    console.error('  Select new report (newer):');
    const remaining = state.reports.filter((_, i) => i !== idxA);
    const idxB = await choose('New report?', remaining);
    reportB = remaining[idxB];
  } else if (state.reports.length === 1) {
    reportA = state.reports[0];
    console.error(`\n  Using report: ${reportA}`);
    reportB = await askPath('Path to second report');
  } else {
    reportA = await askPath('Path to baseline report (older)');
    reportB = await askPath('Path to new report (newer)');
  }

  const { diffReports, diffToMarkdown } = await import('../../history/diff.js');
  const a = JSON.parse(fs.readFileSync(path.resolve(reportA), 'utf-8'));
  const b = JSON.parse(fs.readFileSync(path.resolve(reportB), 'utf-8'));
  const diff = diffReports(a, b);

  console.error(diffToMarkdown(diff));
  process.stdout.write(JSON.stringify(diff, null, 2) + '\n');

  return diff.summary.new_failures > 0 ? ExitCode.ASSERTION_FAILURE : ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Flow: Stats
// ---------------------------------------------------------------------------

async function flowStats(state: ProjectState, { askPath }: PromptFns): Promise<number> {
  const histDir = state.historyDir ?? await askPath('Path to history directory', '.specify/history');

  const { createHistoryStore } = await import('../../history/store.js');
  const { computeStats, statsToMarkdown } = await import('../../history/statistics.js');

  const store = createHistoryStore(histDir);
  const reports = store.list().map(id => store.load(id));
  const stats = computeStats(reports);

  console.error(statsToMarkdown(stats));
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Flow: Generate
// ---------------------------------------------------------------------------

async function flowGenerate(state: ProjectState, { ask, askPath, choose, confirm }: PromptFns): Promise<number> {
  const capturePath = await pickCapture(state, { askPath, choose } as PromptFns);

  const smart = await confirm('Use smart generation (semantic grouping, flow inference)?');
  const specName = await ask('Spec name', 'Generated Spec');
  const outputPath = await askPath('Output file', 'spec.yaml');

  console.error('\n  Generating spec...\n');

  const { generateSpec } = await import('../../spec/generator.js');
  const spec = generateSpec({
    inputDir: path.resolve(capturePath),
    specName,
    smart,
  });

  const yaml = specToYaml(spec);

  console.error(`  Pages: ${spec.pages?.length ?? 0}`);
  console.error(`  Flows: ${spec.flows?.length ?? 0}`);

  fs.writeFileSync(path.resolve(outputPath), yaml, 'utf-8');
  console.error(`\n  Spec written to: ${outputPath}`);

  return ExitCode.SUCCESS;
}

// ---------------------------------------------------------------------------
// Flow: Create new spec
// ---------------------------------------------------------------------------

async function flowCreate(
  { ask, askPath, confirm }: PromptFns,
  fromCapture?: string,
): Promise<number> {
  console.error('');
  const name = await ask('App name', 'my-app');
  const baseUrl = await ask('Base URL', 'http://localhost:3000');
  const description = await ask('Description', `Spec for ${name}`);
  const outputPath = await askPath('Output file', 'spec.yaml');

  const pages: PageSpec[] = [];

  // Discover pages from capture if provided
  if (fromCapture) {
    console.error(`\n  Loading pages from capture: ${fromCapture}`);
    const trafficPath = path.join(fromCapture, 'traffic.json');
    if (fs.existsSync(trafficPath)) {
      const traffic = JSON.parse(fs.readFileSync(trafficPath, 'utf-8')) as Array<{ url: string; method: string }>;
      const pagePaths = new Set<string>();
      for (const entry of traffic) {
        if (entry.method.toUpperCase() === 'GET') {
          try { pagePaths.add(new URL(entry.url).pathname); } catch { /* skip */ }
        }
      }
      for (const p of pagePaths) {
        const id = p.replace(/^\//, '').replace(/[\/\?&#=.]/g, '-').replace(/-+/g, '-') || 'root';
        pages.push({ id, path: p, console_expectations: [{ level: 'error', count: 0 }] });
      }
      console.error(`  Loaded ${pages.length} page(s)`);
    }
  } else {
    // Offer to crawl
    const shouldCrawl = await confirm('Auto-discover pages by crawling the URL?', false);
    if (shouldCrawl) {
      console.error(`\n  Crawling ${baseUrl}...`);
      try {
        const discovered = await discoverPages(baseUrl, { maxPages: 10 });
        console.error(`  Found ${discovered.length} page(s)\n`);
        for (const page of discovered) {
          const include = await confirm(`Include ${page.path}${page.title ? ` (${page.title})` : ''}?`);
          if (include) {
            pages.push(discoveredToPageSpec(page));
          }
        }
      } catch (err) {
        console.error(`  Crawl failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  // Manual pages
  let addMore = pages.length === 0 || await confirm('Add pages manually?', false);
  while (addMore) {
    const pagePath = await ask('Page path (e.g., /dashboard)');
    if (!pagePath) break;
    const pageId = pagePath.replace(/^\//, '').replace(/[\/\?&#=.]/g, '-').replace(/-+/g, '-') || 'root';
    pages.push({ id: pageId, path: pagePath, console_expectations: [{ level: 'error', count: 0 }] });
    console.error(`  Added: ${pageId}`);
    addMore = await confirm('Add another page?', false);
  }

  const useDefaults = await confirm('Enable default checks (no 5xx, no console errors)?');

  const spec: Spec = {
    version: '1.0',
    name,
    description,
    pages: pages.length > 0 ? pages : undefined,
    variables: { base_url: baseUrl },
    ...(useDefaults ? { defaults: { no_5xx: true, no_console_errors: true } } : {}),
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
    { label: 'From existing test code', action: 'code' },
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
    case 'code':
      return await flowImportTests(state, prompts);
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
      console.error(`  Spec validated: ${specOutputPath} (${spec.pages?.length ?? 0} pages)`);
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
  const { choose } = prompts;

  const options = [
    { label: 'Against captured data — offline validation', action: 'data' },
    { label: 'Against a live URL — autonomous agent verification', action: 'agent' },
    { label: 'CLI commands — run and validate command output', action: 'cli' },
    { label: 'Diff two reports — detect regressions', action: 'diff' },
    { label: 'Statistical confidence — analyze run history', action: 'stats' },
  ];

  let action: string;
  if (subAction) {
    const match = options.find(o => o.action === subAction);
    action = match ? match.action : subAction;
  } else {
    const idx = await choose('How would you like to verify?', options.map(o => o.label));
    action = options[idx].action;
  }

  switch (action) {
    case 'data':
      return await flowValidate(state, prompts);
    case 'agent':
      return await flowAgent(state, prompts);
    case 'cli': {
      const specPath = await pickSpec(state, prompts);
      const { loadSpec: loadSpecForCli } = await import('../../spec/parser.js');
      let cliSpec;
      try { cliSpec = loadSpecForCli(specPath); } catch { /* handled by cliRun */ }
      if (cliSpec?.cli) {
        console.error(`\n  CLI target: ${cliSpec.cli.binary}`);
        console.error(`  Commands: ${(cliSpec.cli.commands || []).length}`);
      } else {
        console.error('\n  Warning: spec has no cli section — nothing to verify');
      }
      console.error('  Running CLI verification...\n');
      const { cliRun } = await import('../commands/cli-run.js');
      return await cliRun(
        { spec: specPath },
        { outputFormat: 'text', quiet: false },
      );
    }
    case 'diff':
      return await flowDiff(state, prompts);
    case 'stats':
      return await flowStats(state, prompts);
    default:
      return ExitCode.SUCCESS;
  }
}

// ---------------------------------------------------------------------------
// Flow: Import e2e tests
// ---------------------------------------------------------------------------

async function flowImportTests(state: ProjectState, { ask, askPath }: PromptFns): Promise<number> {
  let testDir: string;
  if (state.e2eTestDirs.length === 1) {
    testDir = state.e2eTestDirs[0];
    console.error(`\n  Using test directory: ${testDir}`);
  } else if (state.e2eTestDirs.length > 1) {
    testDir = await askPath('Path to test file or directory', state.e2eTestDirs[0]);
  } else {
    testDir = await askPath('Path to test file or directory');
  }

  const framework = state.e2eFramework && state.e2eFramework !== 'unknown'
    ? state.e2eFramework
    : undefined;

  const outputPath = await ask('Output spec file (empty to only show analysis)', '');

  console.error('\n  Analyzing test files...\n');

  const { specImport } = await import('../commands/spec-import.js');
  return await specImport(
    { from: testDir, framework, output: outputPath || undefined },
    { outputFormat: 'text', quiet: false },
  );
}

// ---------------------------------------------------------------------------
// Flow: Sync spec against e2e tests
// ---------------------------------------------------------------------------

async function flowSyncTests(state: ProjectState, { askPath, choose }: PromptFns): Promise<number> {
  const specPath = await pickSpec(state, { askPath, choose } as PromptFns);

  let testDir: string;
  if (state.e2eTestDirs.length === 1) {
    testDir = state.e2eTestDirs[0];
    console.error(`  Using test directory: ${testDir}`);
  } else if (state.e2eTestDirs.length > 1) {
    testDir = await askPath('Path to test directory', state.e2eTestDirs[0]);
  } else {
    testDir = await askPath('Path to test directory');
  }

  const framework = state.e2eFramework && state.e2eFramework !== 'unknown'
    ? state.e2eFramework
    : undefined;

  console.error('\n  Computing sync...\n');

  const { specSync } = await import('../commands/spec-sync.js');
  return await specSync(
    { spec: specPath, tests: testDir, framework },
    { outputFormat: 'text', quiet: false },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function discoveredToPageSpec(page: DiscoveredPage): PageSpec {
  const id = page.path.replace(/^\//, '').replace(/[\/\?&#=.]/g, '-').replace(/-+/g, '-') || 'root';
  return {
    id,
    path: page.path,
    ...(page.title ? { title: page.title } : {}),
    console_expectations: [{ level: 'error', count: 0 }],
  };
}
