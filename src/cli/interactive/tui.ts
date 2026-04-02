/**
 * src/cli/interactive/tui.ts — Live terminal dashboard
 *
 * Lightweight TUI using ANSI escape codes for monitoring
 * agent runs and spec status.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Spec } from '../../spec/types.js';
import { ExitCode } from '../exit-codes.js';
import { eventBus } from '../../agent/event-bus.js';

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

type CheckStatus = 'passed' | 'failed' | 'untested';

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

interface LiveBehavior {
  id: string;
  status: 'passed' | 'failed' | 'skipped';
  description?: string;
}

interface TuiState {
  spec: Spec | null;
  agentResult: AgentResult | null;
  selectedPage: number;
  running: boolean;
  lastVerifyPass?: boolean;
  lastError?: string;
  /** Live behavior results streamed during agent run (before final result). */
  liveBehaviors: LiveBehavior[];
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
    agentResult: null,
    selectedPage: 0,
    running: false,
    liveBehaviors: [],
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

  // Subscribe to live behavior events from the agent
  eventBus.onAny((event) => {
    if (event.type.startsWith('behavior:') && state.running) {
      const data = event.data as { id: string; status?: string; description?: string };
      if (data.id && data.status) {
        state.liveBehaviors.push({
          id: data.id,
          status: data.status as LiveBehavior['status'],
          description: data.description,
        });
        render(state);
      }
    }
  });

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
      const maxPages = state.agentResult?.results?.length ?? 0;
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
        state.liveBehaviors = [];
        render(state);
        try {
          const { runSpecifyAgent } = await import('../../agent/sdk-runner.js');
          const { getVerifyPrompt } = await import('../../agent/prompts.js');
          const { loadSpec, specToYaml } = await import('../../spec/parser.js');
          const resolvedSpec = path.resolve(options.spec);
          const spec = loadSpec(resolvedSpec);
          const prompt = getVerifyPrompt(specToYaml(spec));
          const { structuredOutput } = await runSpecifyAgent({
            task: 'verify',
            systemPrompt: prompt,
            userPrompt: `Verify ${options.url} against the behavioral spec.`,
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
    // Show live behavior results as they stream in
    if (state.liveBehaviors.length > 0) {
      output += `\n`;
      for (const b of state.liveBehaviors.slice(-(rows - 10))) {
        const icon = b.status === 'passed' ? `${GREEN}[pass]${RESET}`
          : b.status === 'failed' ? `${RED}[FAIL]${RESET}`
          : `${DIM}[skip]${RESET}`;
        const desc = b.description ? ` ${b.description.substring(0, 50)}` : '';
        output += `  ${icon} ${b.id}${desc}\n`;
      }
    }
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
  } else {
    // Idle — no results yet
    output += `\n${WHITE} Spec loaded: ${state.spec?.name ?? 'none'}${RESET}\n`;
    output += ` Areas: ${state.spec?.areas?.length ?? 0}\n`;
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

