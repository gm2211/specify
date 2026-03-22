/**
 * src/cli/interactive/tui.ts — Live terminal dashboard
 *
 * Lightweight TUI using ANSI escape codes for monitoring
 * agent runs and spec status.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Spec } from '../../spec/types.js';
import { isV1 } from '../../spec/types.js';
import type { GapReport, PageResult, CheckStatus } from '../../validation/types.js';
import { ExitCode } from '../exit-codes.js';

// ANSI escape codes
const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;

const STATUS_ICON: Record<CheckStatus, string> = {
  passed: `${GREEN}[pass]${RESET}`,
  failed: `${RED}[FAIL]${RESET}`,
  untested: `${DIM}[skip]${RESET}`,
};

interface AgentResult {
  pass: boolean;
  summary: string;
  results: { id: string; pass: boolean; evidence: string }[];
}

interface TuiState {
  spec: Spec | null;
  report: GapReport | null;
  agentResult: AgentResult | null;
  selectedPage: number;
  running: boolean;
  lastVerifyPass?: boolean;
  lastError?: string;
}

export async function runTui(options: {
  spec: string;
  url: string;
}): Promise<number> {
  const { loadSpec } = await import('../../spec/parser.js');

  let spec: Spec;
  try {
    spec = loadSpec(options.spec);
  } catch (err) {
    console.error(`Failed to load spec: ${(err as Error).message}`);
    return ExitCode.PARSE_ERROR;
  }

  const state: TuiState = {
    spec,
    report: null,
    agentResult: null,
    selectedPage: 0,
    running: false,
  };

  // Check if terminal supports raw mode
  if (!process.stdin.isTTY) {
    console.error('TUI requires an interactive terminal');
    return ExitCode.PARSE_ERROR;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  // Initial render
  render(state);

  // Handle keyboard input
  process.stdin.on('data', async (key: string) => {
    // Ctrl+C or q to quit
    if (key === '\u0003' || key === 'q' || key === 'Q') {
      process.stdin.setRawMode(false);
      process.stdout.write(CLEAR);
      process.exit(ExitCode.SUCCESS);
    }

    // Arrow keys
    if (key === '\u001b[A') {
      // Up
      state.selectedPage = Math.max(0, state.selectedPage - 1);
    } else if (key === '\u001b[B') {
      // Down
      const maxPages = state.report?.pages.length ?? (state.spec && isV1(state.spec) ? state.spec.pages?.length ?? 0 : 0);
      if (maxPages > 0) {
        state.selectedPage = Math.min(maxPages - 1, state.selectedPage + 1);
      }
    }

    // Action keys
    if (key === 'r' || key === 'R') {
      if (!state.running) {
        state.running = true;
        state.agentResult = null;
        state.lastError = undefined;
        render(state);
        try {
          const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
          const { getVerifyPrompt } = await import('../../agent/prompts.js');
          const resolvedSpec = path.resolve(options.spec);
          const prompt = getVerifyPrompt(resolvedSpec, options.url);
          const { structuredOutput } = await runSpecifyAgent({
            task: 'verify',
            systemPrompt: prompt,
            userPrompt: `Verify ${options.url} against the spec at ${resolvedSpec}.`,
            url: options.url,
            spec: resolvedSpec,
            outputDir: '.specify/verify',
          });
          const { extractBool } = await import('../../agent/sdk-runner.js');
          const pass = extractBool(structuredOutput, 'pass');
          if (pass !== null) {
            state.lastVerifyPass = pass;
          }
          if (structuredOutput && typeof structuredOutput === 'object') {
            const so = structuredOutput as Record<string, unknown>;
            state.agentResult = {
              pass: pass === true,
              summary: typeof so.summary === 'string' ? so.summary : '',
              results: Array.isArray(so.results) ? so.results as AgentResult['results'] : [],
            };
          }
        } catch (err) {
          state.lastError = err instanceof Error ? err.message : String(err);
        }
        state.running = false;
      }
    }

    render(state);
  });

  // Watch for spec file changes
  fs.watch(options.spec, () => {
    try {
      state.spec = loadSpec(options.spec);
      render(state);
    } catch {
      // Ignore parse errors during editing
    }
  });

  // Keep alive
  return new Promise<number>(() => {
    // Never resolves -- TUI runs until quit
  });
}

function render(state: TuiState): void {
  const { columns = 80, rows = 24 } = process.stdout;

  let output = CLEAR;

  // Header
  const title = state.spec?.name ?? 'Specify Dashboard';
  output += `${BOLD}${CYAN} Specify Dashboard -- ${title}${RESET}\n`;
  output += `${DIM}${'-'.repeat(Math.min(columns, 80))}${RESET}\n`;

  if (state.running) {
    output += `\n${YELLOW} Running agent...${RESET}\n`;
  } else if (state.agentResult) {
    // Agent verification results
    const ar = state.agentResult;
    output += ` ${ar.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`} — ${ar.summary}\n`;
    output += `${DIM}${'-'.repeat(Math.min(columns, 80))}${RESET}\n`;
    for (let i = 0; i < ar.results.length && i < rows - 8; i++) {
      const r = ar.results[i];
      const icon = r.pass ? `${GREEN}[pass]${RESET}` : `${RED}[FAIL]${RESET}`;
      output += `  ${icon} ${r.id}: ${r.evidence.substring(0, 60)}\n`;
    }
    if (state.lastError) {
      output += `\n ${RED}Error: ${state.lastError}${RESET}\n`;
    }
    output += `\n${DIM} [R]un again  [Q]uit${RESET}\n`;
  } else if (state.report) {
    // Split view: pages list + detail
    const pages = state.report.pages;
    const midCol = Math.min(30, Math.floor(columns / 3));

    // Summary bar
    const { passed, failed, untested, coverage } = state.report.summary;
    output += ` ${GREEN}${passed} passed${RESET} | ${RED}${failed} failed${RESET} | ${DIM}${untested} untested${RESET} | Coverage: ${coverage}%\n`;
    output += `${DIM}${'-'.repeat(Math.min(columns, 80))}${RESET}\n`;

    // Page list
    for (let i = 0; i < pages.length && i < rows - 8; i++) {
      const page = pages[i];
      const selected = i === state.selectedPage;
      const pageStatus = getPageStatus(page);
      const prefix = selected ? `${BOLD}> ` : '  ';
      const suffix = selected ? RESET : '';
      output += `${prefix}${STATUS_ICON[pageStatus]} ${page.path.substring(0, midCol - 5)}${suffix}\n`;
    }

    // Detail view for selected page
    if (pages[state.selectedPage]) {
      const page = pages[state.selectedPage];
      output += `\n${DIM}${'-'.repeat(Math.min(columns, 80))}${RESET}\n`;
      output += `${BOLD} ${page.pageId} -- ${page.path}${RESET}\n\n`;

      for (const req of page.requests.slice(0, 8)) {
        output += `  ${STATUS_ICON[req.status]} ${req.method} ${req.urlPattern.substring(0, 50)}`;
        if (req.actualStatus) output += ` (${req.actualStatus})`;
        output += '\n';
      }

      for (const va of page.visualAssertions.slice(0, 4)) {
        output += `  ${STATUS_ICON[va.status]} ${va.type} ${va.selector ?? ''}\n`;
      }

      for (const sc of page.scenarios.slice(0, 4)) {
        output += `  ${STATUS_ICON[sc.status]} scenario: ${sc.scenarioId}\n`;
      }
    }
  } else {
    // Idle — no results yet
    output += `\n${WHITE} Spec loaded: ${state.spec?.name ?? 'none'}${RESET}\n`;
    output += ` Pages: ${state.spec && isV1(state.spec) ? state.spec.pages?.length ?? 0 : 0}\n`;
    output += ` Flows: ${state.spec && isV1(state.spec) ? state.spec.flows?.length ?? 0 : 0}\n`;
    if (state.lastError) {
      output += `\n ${RED}Error: ${state.lastError}${RESET}\n`;
    }
    output += `\n${DIM} Press [R] to run, [Q] to quit${RESET}\n`;
  }

  // Footer
  output += `\n${DIM}${'-'.repeat(Math.min(columns, 80))}${RESET}\n`;
  output += `${DIM} [R]un  [Up/Down]Navigate  [Q]uit${RESET}\n`;

  process.stdout.write(output);
}

function getPageStatus(page: PageResult): CheckStatus {
  if (!page.visited) return 'untested';
  const allResults = [
    ...page.requests.map(r => r.status),
    ...page.visualAssertions.map(v => v.status),
    ...page.consoleExpectations.map(c => c.status),
    ...page.scenarios.map(s => s.status),
  ];
  if (allResults.some(s => s === 'failed')) return 'failed';
  if (allResults.some(s => s === 'passed')) return 'passed';
  return 'untested';
}
