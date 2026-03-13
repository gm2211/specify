/**
 * src/cli-test/runner.ts — Orchestrate CLI validation
 *
 * Executes all commands defined in a spec's cli section,
 * validates results, and produces reports (JSON, Markdown, HTML).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Spec, CliSpec, CliCommandSpec, CliScenarioSpec } from '../spec/types.js';
import type { CliGapReport, CliCommandResult, CliScenarioResult, CliCommandRun } from './types.js';
import { executeCommand } from './executor.js';
import { validateCommandRun } from './validator.js';

export interface CliRunConfig {
  spec: Spec;
  outputDir?: string;
  log?: (msg: string) => void;
}

export interface CliRunResult {
  report: CliGapReport;
  runs: CliCommandRun[];
  outputDir?: string;
}

/** Run all CLI commands from a spec and validate results. */
export async function runCliValidation(config: CliRunConfig): Promise<CliRunResult> {
  const { spec, log } = config;
  const cliSpec = spec.cli;

  if (!cliSpec) {
    throw new Error('Spec has no cli section');
  }

  const allRuns: CliCommandRun[] = [];
  const commandResults: CliCommandResult[] = [];
  const scenarioResults: CliScenarioResult[] = [];

  log?.(`CLI Validation: ${spec.name}`);
  log?.(`Binary: ${cliSpec.binary}`);
  log?.('');

  // Run individual commands
  if (cliSpec.commands?.length) {
    log?.(`Running ${cliSpec.commands.length} command(s)...`);
    for (const cmd of cliSpec.commands) {
      const run = await executeCommand(cmd, cliSpec, log);
      allRuns.push(run);
      const result = validateCommandRun(cmd, run);
      commandResults.push(result);
    }
    log?.('');
  }

  // Run scenarios
  if (cliSpec.scenarios?.length) {
    log?.(`Running ${cliSpec.scenarios.length} scenario(s)...`);
    for (const scenario of cliSpec.scenarios) {
      const result = await runScenario(scenario, cliSpec, allRuns, log);
      scenarioResults.push(result);
    }
    log?.('');
  }

  // Compute summary
  const allResults = [
    ...commandResults,
    ...scenarioResults.flatMap(s => s.steps),
  ];

  let totalChecks = 0;
  let passed = 0;
  let failed = 0;
  let untested = 0;

  for (const result of allResults) {
    // Count exit code + each assertion
    const checks = [
      result.exitCode.status,
      ...result.stdoutAssertions.map(a => a.status),
      ...result.stderrAssertions.map(a => a.status),
    ];
    for (const s of checks) {
      totalChecks++;
      if (s === 'passed') passed++;
      else if (s === 'failed') failed++;
      else untested++;
    }
  }

  const report: CliGapReport = {
    spec: {
      name: spec.name,
      version: spec.version,
      description: spec.description,
    },
    cli: {
      binary: cliSpec.binary,
      timestamp: new Date().toISOString(),
    },
    summary: {
      total: totalChecks,
      passed,
      failed,
      untested,
      coverage: totalChecks > 0 ? Math.round(((passed + failed) / totalChecks) * 100) : 0,
    },
    commands: commandResults,
    scenarios: scenarioResults,
  };

  // Save output
  let outputDir: string | undefined;
  if (config.outputDir) {
    outputDir = path.resolve(config.outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'cli-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'cli-report.md'),
      cliReportToMarkdown(report),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'cli-report.html'),
      cliReportToHtml(report, allRuns),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(outputDir, 'cli-runs.json'),
      JSON.stringify(allRuns, null, 2),
      'utf-8',
    );
    log?.(`Reports written to: ${outputDir}`);
  }

  return { report, runs: allRuns, outputDir };
}

async function runScenario(
  scenario: CliScenarioSpec,
  cliSpec: CliSpec,
  allRuns: CliCommandRun[],
  log?: (msg: string) => void,
): Promise<CliScenarioResult> {
  log?.(`  Scenario: ${scenario.id}${scenario.description ? ` — ${scenario.description}` : ''}`);

  const stepResults: CliCommandResult[] = [];
  let scenarioFailed = false;

  for (const step of scenario.steps) {
    if (scenarioFailed) {
      // Skip remaining steps after failure
      stepResults.push({
        commandId: step.id,
        description: step.description,
        args: step.args,
        status: 'untested',
        exitCode: { expected: step.expected_exit_code ?? 0, actual: -1, status: 'untested' },
        stdoutAssertions: [],
        stderrAssertions: [],
        durationMs: 0,
        timedOut: false,
      });
      continue;
    }

    const run = await executeCommand(step, cliSpec, log);
    allRuns.push(run);
    const result = validateCommandRun(step, run);
    stepResults.push(result);

    if (result.status === 'failed') {
      scenarioFailed = true;
    }
  }

  const status = stepResults.some(s => s.status === 'failed')
    ? 'failed' as const
    : stepResults.some(s => s.status === 'untested')
      ? 'untested' as const
      : 'passed' as const;

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    status,
    steps: stepResults,
  };
}

// ---------------------------------------------------------------------------
// Markdown reporter
// ---------------------------------------------------------------------------

/** Escape pipe characters for markdown table cells. */
function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Format a value for display in a markdown table cell. */
function mdValue(v: unknown, maxLen = 80): string {
  if (v === undefined || v === null) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const escaped = mdEscape(s);
  if (escaped.length > maxLen) return `\`${escaped.slice(0, maxLen)}...\``;
  return `\`${escaped}\``;
}

export function cliReportToMarkdown(report: CliGapReport): string {
  const lines: string[] = [];
  const icon = (s: string) =>
    s === 'passed' ? '✅' : s === 'failed' ? '❌' : '⬜';

  lines.push(`# CLI Validation Report: ${report.spec.name}`);
  lines.push('');
  if (report.spec.description) {
    lines.push(`> ${report.spec.description}`);
    lines.push('');
  }

  lines.push('## Metadata');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| Binary | \`${report.cli.binary}\` |`);
  lines.push(`| Timestamp | ${report.cli.timestamp} |`);
  lines.push(`| Spec version | \`${report.spec.version}\` |`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|--------|-------|');
  lines.push(`| ✅ Passed | ${report.summary.passed} |`);
  lines.push(`| ❌ Failed | ${report.summary.failed} |`);
  lines.push(`| ⬜ Untested | ${report.summary.untested} |`);
  lines.push(`| **Total** | **${report.summary.total}** |`);
  lines.push(`| **Coverage** | **${report.summary.coverage}%** |`);
  lines.push('');

  // Commands
  if (report.commands.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Commands');
    lines.push('');
    for (const cmd of report.commands) {
      renderCommandMarkdown(cmd, lines, icon);
    }
  }

  // Scenarios
  if (report.scenarios.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Scenarios');
    lines.push('');
    for (const sc of report.scenarios) {
      lines.push(`### ${icon(sc.status)} Scenario: \`${sc.scenarioId}\``);
      if (sc.description) lines.push(`> ${sc.description}`);
      lines.push('');

      for (const step of sc.steps) {
        renderCommandMarkdown(step, lines, icon);
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Generated by Specify CLI validator · ${new Date().toISOString()}_`);
  lines.push('');

  return lines.join('\n');
}

function renderCommandMarkdown(
  cmd: CliCommandResult,
  lines: string[],
  icon: (s: string) => string,
): void {
  lines.push(`### ${icon(cmd.status)} \`${cmd.commandId}\``);
  if (cmd.description) lines.push(`> ${cmd.description}`);
  lines.push('');
  lines.push(`**Args:** \`${cmd.args.join(' ')}\` · **Duration:** ${cmd.durationMs}ms`);
  lines.push('');

  // Exit code
  lines.push(`**Exit code:** expected \`${JSON.stringify(cmd.exitCode.expected)}\`, got \`${cmd.exitCode.actual}\` ${icon(cmd.exitCode.status)}`);
  lines.push('');

  // Output preview
  if (cmd.stdoutPreview) {
    lines.push('<details>');
    lines.push('<summary>stdout preview</summary>');
    lines.push('');
    lines.push('```');
    lines.push(cmd.stdoutPreview);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (cmd.stderrPreview) {
    lines.push('<details>');
    lines.push('<summary>stderr preview</summary>');
    lines.push('');
    lines.push('```');
    lines.push(cmd.stderrPreview);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Assertion tables with expected/actual
  if (cmd.stdoutAssertions.length > 0) {
    lines.push('**stdout assertions:**');
    lines.push('');
    lines.push('| Status | Type | Description | Expected | Actual |');
    lines.push('|--------|------|-------------|----------|--------|');
    for (const a of cmd.stdoutAssertions) {
      lines.push(`| ${icon(a.status)} | \`${a.type}\` | ${a.description ?? '—'} | ${mdValue(a.expected)} | ${mdValue(a.actual)} |`);
    }
    lines.push('');
  }

  if (cmd.stderrAssertions.length > 0) {
    lines.push('**stderr assertions:**');
    lines.push('');
    lines.push('| Status | Type | Description | Expected | Actual |');
    lines.push('|--------|------|-------------|----------|--------|');
    for (const a of cmd.stderrAssertions) {
      lines.push(`| ${icon(a.status)} | \`${a.type}\` | ${a.description ?? '—'} | ${mdValue(a.expected)} | ${mdValue(a.actual)} |`);
    }
    lines.push('');
  }
}

// ---------------------------------------------------------------------------
// HTML reporter
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlValue(v: unknown, maxLen = 120): string {
  if (v === undefined || v === null) return '<span class="dim">—</span>';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const truncated = s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
  return `<code>${escapeHtml(truncated)}</code>`;
}

export function cliReportToHtml(report: CliGapReport, runs: CliCommandRun[]): string {
  const runMap = new Map<string, CliCommandRun>();
  for (const run of runs) {
    runMap.set(run.id, run);
  }

  const { passed, failed, untested, total } = report.summary;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;

  const allCommands = [
    ...report.commands,
    ...report.scenarios.flatMap(s => s.steps),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CLI Validation Report — ${escapeHtml(report.spec.name)}</title>
<style>
  :root {
    --pass: #22c55e; --pass-bg: #f0fdf4; --pass-border: #bbf7d0;
    --fail: #ef4444; --fail-bg: #fef2f2; --fail-border: #fecaca;
    --untested: #9ca3af; --untested-bg: #f9fafb;
    --bg: #ffffff; --surface: #f8fafc; --border: #e2e8f0;
    --text: #1e293b; --text-dim: #64748b;
    --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--sans); color: var(--text); background: var(--bg); line-height: 1.5; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .subtitle { color: var(--text-dim); margin-bottom: 24px; font-size: 0.9rem; }
  .meta { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; font-size: 0.85rem; color: var(--text-dim); }
  .meta code { background: var(--surface); padding: 2px 6px; border-radius: 4px; font-family: var(--mono); font-size: 0.8rem; }

  /* Summary */
  .summary { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat { padding: 16px 24px; border-radius: 8px; text-align: center; min-width: 120px; }
  .stat .number { font-size: 2rem; font-weight: 700; }
  .stat .label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-pass { background: var(--pass-bg); border: 1px solid var(--pass-border); color: var(--pass); }
  .stat-fail { background: var(--fail-bg); border: 1px solid var(--fail-border); color: var(--fail); }
  .stat-untested { background: var(--untested-bg); border: 1px solid var(--border); color: var(--untested); }
  .progress-bar { height: 8px; border-radius: 4px; background: var(--border); margin-bottom: 24px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .progress-green { background: var(--pass); }
  .progress-red { background: var(--fail); }

  /* Controls */
  .controls { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .controls input[type="text"] { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; min-width: 200px; font-family: var(--sans); }
  .controls button { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); cursor: pointer; font-size: 0.8rem; font-family: var(--sans); }
  .controls button:hover { background: var(--border); }
  .controls button.active { background: var(--text); color: white; border-color: var(--text); }

  /* Command cards */
  .command { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
  .command.failed { border-color: var(--fail-border); }
  .command summary { padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.9rem; user-select: none; list-style: none; }
  .command summary::-webkit-details-marker { display: none; }
  .command summary::before { content: '▶'; font-size: 0.7rem; transition: transform 0.15s; color: var(--text-dim); }
  .command[open] summary::before { transform: rotate(90deg); }
  .command summary:hover { background: var(--surface); }
  .command-body { padding: 0 16px 16px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot-pass { background: var(--pass); }
  .dot-fail { background: var(--fail); }
  .dot-untested { background: var(--untested); }
  .cmd-id { font-weight: 600; font-family: var(--mono); font-size: 0.85rem; }
  .cmd-args { color: var(--text-dim); font-family: var(--mono); font-size: 0.8rem; margin-left: 8px; }
  .cmd-duration { margin-left: auto; color: var(--text-dim); font-size: 0.75rem; }
  .cmd-desc { color: var(--text-dim); font-size: 0.85rem; margin-bottom: 12px; }

  /* Exit code */
  .exit-row { font-size: 0.85rem; margin-bottom: 12px; }
  .exit-row code { font-family: var(--mono); }

  /* Output blocks */
  .output-block { margin-bottom: 12px; }
  .output-block summary { font-size: 0.8rem; color: var(--text-dim); cursor: pointer; padding: 4px 0; }
  .output-block pre { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-family: var(--mono); font-size: 0.75rem; max-height: 400px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin-top: 4px; }
  .output-block.stderr pre { background: #fef2f2; border-color: #fecaca; }

  /* Assertion table */
  .assert-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 12px; }
  .assert-table th { text-align: left; padding: 6px 8px; background: var(--surface); border-bottom: 2px solid var(--border); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .assert-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .assert-table tr.row-fail { background: var(--fail-bg); }
  .assert-table code { font-family: var(--mono); font-size: 0.75rem; background: var(--surface); padding: 1px 4px; border-radius: 3px; word-break: break-all; }
  .assert-table tr.row-fail code { background: #fee2e2; }
  .dim { color: var(--text-dim); }

  /* Section headers */
  .section-title { font-size: 1.1rem; font-weight: 600; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 2px solid var(--border); }

  /* Scenario wrapper */
  .scenario { margin-bottom: 24px; }
  .scenario-header { font-size: 0.95rem; font-weight: 600; margin-bottom: 4px; }
  .scenario-desc { color: var(--text-dim); font-size: 0.85rem; margin-bottom: 12px; }

  @media print {
    .controls { display: none; }
    .command { break-inside: avoid; }
    .command[open] { break-inside: auto; }
    details { open: true; }
    .output-block pre { max-height: none; }
  }
  @media (max-width: 600px) {
    body { padding: 12px; }
    .summary { flex-direction: column; }
    .stat { min-width: auto; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(report.spec.name)}</h1>
${report.spec.description ? `<div class="subtitle">${escapeHtml(report.spec.description)}</div>` : ''}
<div class="meta">
  <span>Binary: <code>${escapeHtml(report.cli.binary)}</code></span>
  <span>Version: <code>${escapeHtml(report.spec.version)}</code></span>
  <span>Timestamp: ${escapeHtml(report.cli.timestamp)}</span>
</div>

<div class="summary">
  <div class="stat stat-pass"><div class="number">${passed}</div><div class="label">Passed</div></div>
  <div class="stat stat-fail"><div class="number">${failed}</div><div class="label">Failed</div></div>
  <div class="stat stat-untested"><div class="number">${untested}</div><div class="label">Untested</div></div>
  <div class="stat" style="border:1px solid var(--border)"><div class="number">${total}</div><div class="label">Total Checks</div></div>
</div>
<div class="progress-bar"><div class="progress-fill ${failed > 0 ? 'progress-red' : 'progress-green'}" style="width:${pct}%"></div></div>

<div class="controls">
  <input type="text" id="search" placeholder="Filter commands..." oninput="filterCommands()">
  <button onclick="setFilter('all')" class="active" id="btn-all">All (${allCommands.length})</button>
  <button onclick="setFilter('passed')" id="btn-passed">Passed</button>
  <button onclick="setFilter('failed')" id="btn-failed">Failed</button>
  <button onclick="toggleAll(true)">Expand All</button>
  <button onclick="toggleAll(false)">Collapse All</button>
</div>

${report.commands.length > 0 ? `<div class="section-title">Commands (${report.commands.length})</div>` : ''}
<div id="commands">
${report.commands.map(cmd => renderCommandHtml(cmd, runMap)).join('\n')}
</div>

${report.scenarios.length > 0 ? `<div class="section-title">Scenarios (${report.scenarios.length})</div>` : ''}
<div id="scenarios">
${report.scenarios.map(sc => `
<div class="scenario">
  <div class="scenario-header"><span class="dot dot-${sc.status}"></span> ${escapeHtml(sc.scenarioId)}</div>
  ${sc.description ? `<div class="scenario-desc">${escapeHtml(sc.description)}</div>` : ''}
  ${sc.steps.map(step => renderCommandHtml(step, runMap)).join('\n')}
</div>
`).join('\n')}
</div>

<div style="margin-top:24px;color:var(--text-dim);font-size:0.8rem;">Generated by Specify CLI validator · ${escapeHtml(report.cli.timestamp)}</div>

<script>
let currentFilter = 'all';
function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.controls button[id^="btn-"]').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-' + f)?.classList.add('active');
  filterCommands();
}
function filterCommands() {
  const q = document.getElementById('search').value.toLowerCase();
  document.querySelectorAll('.command').forEach(el => {
    const text = el.textContent.toLowerCase();
    const status = el.dataset.status;
    const matchFilter = currentFilter === 'all' || status === currentFilter;
    const matchSearch = !q || text.includes(q);
    el.style.display = matchFilter && matchSearch ? '' : 'none';
  });
}
function toggleAll(open) {
  document.querySelectorAll('.command').forEach(el => {
    if (el.style.display !== 'none') el.open = open;
  });
}
</script>
</body>
</html>`;
}

function renderCommandHtml(cmd: CliCommandResult, runMap: Map<string, CliCommandRun>): string {
  const run = runMap.get(cmd.commandId);
  const statusClass = cmd.status === 'failed' ? ' failed' : '';
  const argsStr = cmd.args.join(' ');

  const assertionRows = (assertions: typeof cmd.stdoutAssertions, stream: string) => {
    if (assertions.length === 0) return '';
    return `
    <div style="font-size:0.8rem;font-weight:600;margin:8px 0 4px;color:var(--text-dim)">${stream} assertions</div>
    <table class="assert-table">
      <tr><th>Status</th><th>Type</th><th>Description</th><th>Expected</th><th>Actual</th></tr>
      ${assertions.map(a => {
        const rowClass = a.status === 'failed' ? ' class="row-fail"' : '';
        return `<tr${rowClass}>
          <td><span class="dot dot-${a.status}"></span></td>
          <td><code>${escapeHtml(a.type)}</code></td>
          <td>${a.description ? escapeHtml(a.description) : '<span class="dim">—</span>'}</td>
          <td>${htmlValue(a.expected)}</td>
          <td>${htmlValue(a.actual)}</td>
        </tr>`;
      }).join('\n')}
    </table>`;
  };

  // Full output from runs (not the preview — full output for HTML)
  const stdoutBlock = run?.stdout ? `
    <details class="output-block">
      <summary>stdout (${run.stdout.length} chars)</summary>
      <pre>${escapeHtml(run.stdout)}</pre>
    </details>` : '';

  const stderrBlock = run?.stderr ? `
    <details class="output-block stderr">
      <summary>stderr (${run.stderr.length} chars)</summary>
      <pre>${escapeHtml(run.stderr)}</pre>
    </details>` : '';

  return `<details class="command${statusClass}" data-status="${cmd.status}">
  <summary>
    <span class="dot dot-${cmd.status}"></span>
    <span class="cmd-id">${escapeHtml(cmd.commandId)}</span>
    <span class="cmd-args">${escapeHtml(argsStr)}</span>
    <span class="cmd-duration">${cmd.durationMs}ms</span>
  </summary>
  <div class="command-body">
    ${cmd.description ? `<div class="cmd-desc">${escapeHtml(cmd.description)}</div>` : ''}
    <div class="exit-row">Exit code: expected <code>${JSON.stringify(cmd.exitCode.expected)}</code>, got <code>${cmd.exitCode.actual}</code> <span class="dot dot-${cmd.exitCode.status}"></span></div>
    ${stdoutBlock}
    ${stderrBlock}
    ${assertionRows(cmd.stdoutAssertions, 'stdout')}
    ${assertionRows(cmd.stderrAssertions, 'stderr')}
  </div>
</details>`;
}
