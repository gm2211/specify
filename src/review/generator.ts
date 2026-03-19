/**
 * src/review/generator.ts — Generate a self-contained HTML spec browser
 *
 * Produces a single HTML file with embedded data (spec, narrative, reports)
 * and vanilla JS for interactivity. No external dependencies at runtime.
 */

import type { Spec } from '../spec/types.js';
import type { NarrativeDocument } from '../spec/narrative.js';
import type { GapReport } from '../validation/types.js';
import type { CliGapReport } from '../cli-test/types.js';

export interface ReviewData {
  spec: Spec;
  narrative?: NarrativeDocument;
  webReport?: GapReport;
  cliReport?: CliGapReport;
}

export function generateReviewHtml(data: ReviewData): string {
  const jsonPayload = JSON.stringify(data, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.spec.name)} — Specify</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app">
  <header id="header">
    <div class="header-left">
      <h1 id="spec-title"></h1>
      <span id="spec-version" class="badge badge-neutral"></span>
    </div>
    <div class="header-right">
      <div id="summary-badges"></div>
    </div>
  </header>
  <div id="layout">
    <nav id="sidebar">
      <div id="toc"></div>
    </nav>
    <main id="content">
      <div id="narrative-view"></div>
    </main>
    <aside id="detail-panel" class="hidden">
      <div id="detail-header">
        <h3 id="detail-title"></h3>
        <button onclick="closeDetail()" class="close-btn">&times;</button>
      </div>
      <div id="detail-body"></div>
    </aside>
  </div>
</div>
<script>
// Embedded data
const DATA = ${jsonPayload};
</script>
<script>
${JS}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg: #0d1117;
  --bg-surface: #161b22;
  --bg-hover: #1c2128;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --text-dim: #6e7681;
  --accent: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --orange: #db6d28;
  --sidebar-w: 260px;
  --detail-w: 380px;
  --header-h: 56px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}

#app { min-height: 100vh; display: flex; flex-direction: column; }

/* Header */
#header {
  height: var(--header-h);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: var(--bg-surface);
  position: sticky; top: 0; z-index: 10;
}
.header-left { display: flex; align-items: center; gap: 12px; }
.header-left h1 { font-size: 18px; font-weight: 600; }
.header-right { display: flex; align-items: center; gap: 16px; }

/* Toggle */
.toggle-group {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.toggle-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s, color 0.15s;
}
.toggle-btn:hover { background: var(--bg-hover); }
.toggle-btn.active { background: var(--accent); color: #fff; }

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}
.badge-pass { background: rgba(63,185,80,0.15); color: var(--green); }
.badge-fail { background: rgba(248,81,73,0.15); color: var(--red); }
.badge-untested { background: rgba(110,118,129,0.15); color: var(--text-dim); }
.badge-neutral { background: rgba(88,166,255,0.15); color: var(--accent); }
.badge-warn { background: rgba(210,153,34,0.15); color: var(--yellow); }

#summary-badges { display: flex; gap: 8px; }

/* Layout */
#layout {
  display: flex;
  flex: 1;
  height: calc(100vh - var(--header-h));
}

/* Sidebar */
#sidebar {
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 12px 0;
  background: var(--bg-surface);
}

.toc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-muted);
  text-decoration: none;
  transition: background 0.1s;
  border-left: 2px solid transparent;
}
.toc-item:hover { background: var(--bg-hover); color: var(--text); }
.toc-item.active { border-left-color: var(--accent); color: var(--text); background: var(--bg-hover); }
.toc-item.depth-1 { padding-left: 16px; font-weight: 600; }
.toc-item.depth-2 { padding-left: 32px; }
.toc-item.depth-3 { padding-left: 48px; font-size: 12px; }

.toc-status {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.toc-status.pass { background: var(--green); }
.toc-status.fail { background: var(--red); }
.toc-status.untested { background: var(--text-dim); }
.toc-status.mixed { background: var(--yellow); }

/* Main content */
#content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 48px;
  max-width: 900px;
}

.section {
  margin-bottom: 32px;
  padding: 20px 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface);
  cursor: pointer;
  transition: border-color 0.15s;
}
.section:hover { border-color: var(--accent); }
.section.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.section-header h2 { font-size: 18px; font-weight: 600; }
.section-header h3 { font-size: 15px; font-weight: 600; }
.section-badges { display: flex; gap: 6px; }

.section-body { color: var(--text-muted); font-size: 14px; }
.section-body p { margin-bottom: 8px; }
.section-refs {
  margin-top: 8px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.ref-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(88,166,255,0.1);
  color: var(--accent);
  font-family: 'SFMono-Regular', Consolas, monospace;
}
.ref-tag.stale {
  background: rgba(248,81,73,0.15);
  color: var(--red);
  text-decoration: line-through;
}

/* Spec view (inline per card, see .inline-spec) */

/* Detail panel */
#detail-panel {
  width: var(--detail-w);
  min-width: var(--detail-w);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  background: var(--bg-surface);
  padding: 16px;
}
#detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
#detail-header h3 { font-size: 15px; }
.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
}
.close-btn:hover { color: var(--text); }

.assertion-item {
  padding: 8px 12px;
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 13px;
}
.assertion-item.pass { border-left: 3px solid var(--green); }
.assertion-item.fail { border-left: 3px solid var(--red); }
.assertion-item.untested { border-left: 3px solid var(--text-dim); }

.assertion-type {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}
.assertion-desc { color: var(--text); }
.assertion-detail {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.detail-section {
  margin-bottom: 16px;
}
.detail-section-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.hidden { display: none !important; }

/* Per-card spec toggle */
.spec-toggle-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.spec-toggle-btn:hover { background: var(--bg-hover); color: var(--text); }
.spec-toggle-btn.active { background: rgba(88,166,255,0.15); color: var(--accent); border-color: var(--accent); }

.inline-spec {
  margin-top: 12px;
  padding: 12px 16px;
  background: rgba(0,0,0,0.3);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.inline-spec .spec-key { color: var(--accent); }
.inline-spec .spec-val { color: var(--text); }
.inline-spec .spec-comment { color: var(--text-dim); font-style: italic; }

/* CLI assertion detail styles */
.cli-args {
  padding: 4px 8px;
  background: rgba(0,0,0,0.25);
  border-radius: 4px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  margin: 4px 0;
}
.cli-assertion-group {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.cli-assertion-group-label {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}
.cli-assertion {
  font-size: 12px;
  padding: 3px 0;
  margin-left: 8px;
}
.cli-assertion.pass .cli-assert-icon { color: var(--green); }
.cli-assertion.fail .cli-assert-icon { color: var(--red); }
.cli-assertion.untested .cli-assert-icon { color: var(--text-dim); }
.cli-assert-type {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
  color: var(--text-dim);
}
.cli-assert-desc { color: var(--text-muted); }
.cli-assert-values {
  font-size: 11px;
  color: var(--text-dim);
  margin-left: 16px;
  margin-top: 2px;
}
.cli-assert-values code {
  background: rgba(0,0,0,0.25);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.cli-assert-reason {
  font-size: 11px;
  color: var(--red);
  margin-left: 16px;
}
.cli-rerun {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.cli-rerun code {
  background: rgba(0,0,0,0.25);
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--text-muted);
}
.exit-code code {
  background: rgba(0,0,0,0.25);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.exit-code.passed { color: var(--green); }
.exit-code.failed { color: var(--red); }

/* Sync warnings */
.sync-warn {
  padding: 8px 12px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: rgba(210,153,34,0.1);
  border: 1px solid rgba(210,153,34,0.3);
  font-size: 13px;
  color: var(--yellow);
}

/* Responsive */
@media (max-width: 900px) {
  #sidebar { display: none; }
  #content { padding: 16px; }
  #detail-panel { position: fixed; right: 0; top: var(--header-h); bottom: 0; z-index: 20; box-shadow: -4px 0 12px rgba(0,0,0,0.4); }
}
`;

// ---------------------------------------------------------------------------
// JS (vanilla, embedded in the HTML)
// ---------------------------------------------------------------------------

const JS = `
(function() {
  'use strict';

  const spec = DATA.spec;
  const narrative = DATA.narrative;
  const webReport = DATA.webReport;
  const cliReport = DATA.cliReport;

  // ---- Helpers ----

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function $(id) { return document.getElementById(id); }

  function statusIcon(status) {
    if (status === 'passed') return '<span class="toc-status pass"></span>';
    if (status === 'failed') return '<span class="toc-status fail"></span>';
    if (status === 'mixed') return '<span class="toc-status mixed"></span>';
    return '<span class="toc-status untested"></span>';
  }

  function badgeFor(status, label) {
    const cls = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'untested';
    return '<span class="badge badge-' + cls + '">' + esc(label) + '</span>';
  }

  // ---- Resolve spec ref to report results ----

  function resolveRef(ref) {
    const results = [];
    const parts = ref.split(':');
    const type = parts[0];

    if (type === 'page' && parts[1]) {
      const pageId = parts[1];
      if (webReport) {
        const pr = webReport.pages?.find(p => p.pageId === pageId);
        if (pr) {
          (pr.visualAssertions || []).forEach(a => results.push({ kind: 'visual', ...a }));
          (pr.requests || []).forEach(a => results.push({ kind: 'request', ...a }));
          (pr.consoleExpectations || []).forEach(a => results.push({ kind: 'console', ...a }));
        }
      }
    }

    if (type === 'scenario') {
      const slash = (parts[1] || '').indexOf('/');
      if (slash > 0) {
        const pageId = parts[1].substring(0, slash);
        const scenarioId = parts[1].substring(slash + 1);
        if (webReport) {
          const pr = webReport.pages?.find(p => p.pageId === pageId);
          if (pr) {
            const sr = (pr.scenarios || []).find(s => s.scenarioId === scenarioId);
            if (sr) {
              (sr.steps || []).forEach(step => results.push({ kind: 'scenario-step', ...step }));
              results.push({ kind: 'scenario', scenarioId: sr.scenarioId, status: sr.status, description: sr.description });
            }
          }
        }
      }
    }

    if (type === 'flow' && parts[1]) {
      const flowId = parts[1];
      if (webReport) {
        const fr = (webReport.flows || []).find(f => f.flowId === flowId);
        if (fr) {
          (fr.steps || []).forEach(step => results.push({ kind: 'flow-step', ...step }));
          results.push({ kind: 'flow', flowId: fr.flowId, status: fr.status, description: fr.description });
        }
      }
    }

    if (type === 'request') {
      const rest = parts.slice(1).join(':');
      const slash = rest.indexOf('/');
      if (slash > 0) {
        const pageId = rest.substring(0, slash);
        const reqKey = rest.substring(slash + 1);
        if (webReport) {
          const pr = webReport.pages?.find(p => p.pageId === pageId);
          if (pr) {
            (pr.requests || []).forEach(r => {
              if ((r.method + ':' + r.urlPattern) === reqKey) {
                results.push({ kind: 'request', ...r });
              }
            });
          }
        }
      }
    }

    if (type === 'defaults') {
      if (spec.defaults) {
        Object.entries(spec.defaults).forEach(function(e) {
          results.push({ kind: 'default', property: e[0], details: String(e[1]), status: 'untested' });
        });
      }
      if (webReport && webReport.defaults) {
        results.length = 0;
        webReport.defaults.forEach(d => results.push({ kind: 'default', ...d }));
      }
    }

    if (type === 'variables') {
      if (spec.variables) {
        Object.entries(spec.variables).forEach(function(e) {
          results.push({ kind: 'variable', name: e[0], value: e[1], status: 'passed' });
        });
      }
    }

    if (type === 'assumptions') {
      if (spec.assumptions) {
        spec.assumptions.forEach(function(a) {
          results.push({ kind: 'assumption', type: a.type, description: a.description, reason: a.reason, status: 'untested' });
        });
      }
      if (webReport && webReport.assumptions) {
        webReport.assumptions.forEach(function(a) { results.push({ kind: 'assumption', ...a }); });
      }
    }

    if (type === 'requirements') {
      if (spec.requirements) {
        spec.requirements.forEach(function(r) {
          results.push({ kind: 'requirement', id: r.id, description: r.description, verification: r.verification, status: 'untested' });
        });
      }
      if (cliReport && cliReport.requirements) {
        results.length = 0;
        cliReport.requirements.forEach(function(r) { results.push({ kind: 'requirement', ...r }); });
      }
    }

    if (type === 'claims') {
      if (spec.claims) {
        spec.claims.forEach(function(c) {
          results.push({ kind: 'claim', id: c.id, description: c.description, status: 'untested' });
        });
      }
      if (cliReport && cliReport.claims) {
        results.length = 0;
        cliReport.claims.forEach(function(c) { results.push({ kind: 'claim', ...c }); });
      }
    }

    if (ref === 'cli') {
      if (spec.cli) {
        results.push({ kind: 'cli-summary', binary: spec.cli.binary, commandCount: (spec.cli.commands || []).length, status: 'passed' });
      }
    }

    if (type === 'cli' && parts.length > 1) {
      var cmdId = parts.slice(1).join(':');
      if (cliReport) {
        var cmd = (cliReport.commands || []).find(function(c) { return c.commandId === cmdId; });
        if (cmd) {
          results.push({ kind: 'cli-command', commandId: cmd.commandId, status: cmd.status,
            description: cmd.description, args: cmd.args, exitCode: cmd.exitCode,
            stdoutAssertions: cmd.stdoutAssertions, stderrAssertions: cmd.stderrAssertions,
            durationMs: cmd.durationMs, timedOut: cmd.timedOut,
            stdoutPreview: cmd.stdoutPreview, stderrPreview: cmd.stderrPreview });
        }
      }
      if (results.length === 0 && spec.cli) {
        var specCmd = (spec.cli.commands || []).find(function(c) { return c.id === cmdId; });
        if (specCmd) {
          results.push({ kind: 'cli-spec', commandId: specCmd.id, description: specCmd.description,
            args: specCmd.args, expectedExitCode: specCmd.expected_exit_code,
            stdoutAssertions: specCmd.stdout_assertions, stderrAssertions: specCmd.stderr_assertions,
            status: 'untested' });
        }
      }
    }

    if (type === 'claim' && parts.length > 1) {
      var claimId = parts.slice(1).join(':');
      if (cliReport && cliReport.claims) {
        var claim = (cliReport.claims || []).find(function(c) { return c.id === claimId; });
        if (claim) {
          results.push({ kind: 'claim', ...claim });
        }
      }
      if (results.length === 0 && spec.claims) {
        var specClaim = (spec.claims || []).find(function(c) { return c.id === claimId; });
        if (specClaim) {
          results.push({ kind: 'claim', id: specClaim.id, description: specClaim.description, status: 'untested' });
        }
      }
    }

    // CLI report — match by command ID pattern (legacy non-prefixed refs)
    if (type !== 'cli' && !ref.startsWith('cli:') && cliReport) {
      for (const cmd of (cliReport.commands || [])) {
        if (cmd.commandId === ref || cmd.commandId === parts[1]) {
          results.push({ kind: 'cli-command', commandId: cmd.commandId, status: cmd.status,
            description: cmd.description, exitCode: cmd.exitCode,
            stdoutAssertions: cmd.stdoutAssertions, stderrAssertions: cmd.stderrAssertions });
        }
      }
    }

    return results;
  }

  function aggregateStatus(results) {
    if (results.length === 0) return 'untested';
    const hasPass = results.some(r => r.status === 'passed');
    const hasFail = results.some(r => r.status === 'failed');
    if (hasFail) return hasPass ? 'mixed' : 'failed';
    if (hasPass) return 'passed';
    return 'untested';
  }

  // ---- Stale ref detection ----

  const validSpecRefs = new Set(['overview', 'defaults', 'meta', 'variables', 'assumptions', 'requirements', 'claims', 'cli']);
  for (const page of (spec.pages || [])) {
    validSpecRefs.add('page:' + page.id);
    for (const s of (page.scenarios || [])) validSpecRefs.add('scenario:' + page.id + '/' + s.id);
    for (const r of (page.expected_requests || [])) validSpecRefs.add('request:' + page.id + '/' + r.method + ':' + r.url_pattern);
  }
  for (const f of (spec.flows || [])) validSpecRefs.add('flow:' + f.id);
  for (const req of (spec.requirements || [])) validSpecRefs.add('requirement:' + req.id);
  for (const claim of (spec.claims || [])) validSpecRefs.add('claim:' + claim.id);
  if (spec.cli) {
    for (const cmd of (spec.cli.commands || [])) validSpecRefs.add('cli:' + cmd.id);
  }

  function isStaleRef(ref) { return !validSpecRefs.has(ref); }

  // ---- Build TOC & narrative ----

  let sections = [];
  let activeSectionIdx = -1;

  function buildFromNarrative() {
    if (!narrative) return;

    // Overview
    if (narrative.overview) {
      sections.push({
        title: 'Overview',
        body: narrative.overview,
        refs: ['overview'],
        depth: 1,
        children: []
      });
    }

    function addSection(ns, depth) {
      const idx = sections.length;
      sections.push({
        title: ns.title,
        body: ns.body,
        refs: ns.specRefs || [],
        depth: depth,
        children: []
      });
      for (const child of (ns.children || [])) {
        addSection(child, depth + 1);
      }
    }

    for (const s of narrative.sections) {
      addSection(s, 1);
    }
  }

  function buildFromSpec() {
    // Fallback: build sections from spec structure when no narrative
    if (spec.description) {
      sections.push({ title: 'Overview', body: spec.description, refs: ['overview'], depth: 1, children: [] });
    }

    // Defaults
    if (spec.defaults) {
      sections.push({
        title: 'Spec Format \\u203a Defaults',
        body: 'Universal properties applied across all pages: ' + Object.entries(spec.defaults).map(function(e) { return e[0] + '=' + e[1]; }).join(', '),
        refs: ['defaults'],
        depth: 1,
        children: []
      });
    }

    // Variables
    if (spec.variables && Object.keys(spec.variables).length > 0) {
      sections.push({
        title: 'Spec Format \\u203a Variables',
        body: 'Template variables: ' + Object.keys(spec.variables).join(', '),
        refs: ['variables'],
        depth: 1,
        children: []
      });
    }

    // Assumptions
    if (spec.assumptions && spec.assumptions.length > 0) {
      sections.push({
        title: 'Spec Format \\u203a Assumptions',
        body: spec.assumptions.map(function(a) { return a.type + (a.description ? ': ' + a.description : ''); }).join('\\n'),
        refs: ['assumptions'],
        depth: 1,
        children: []
      });
    }

    // Requirements
    if (spec.requirements && spec.requirements.length > 0) {
      sections.push({
        title: 'Behavioral Requirements',
        body: spec.requirements.map(function(r) { return r.id + ': ' + r.description; }).join('\\n\\n'),
        refs: ['requirements'],
        depth: 1,
        children: []
      });
    }

    if (spec.claims && spec.claims.length > 0) {
      sections.push({
        title: 'Grounded Claims',
        body: spec.claims.map(function(c) { return c.id + ': ' + c.description; }).join('\\n\\n'),
        refs: ['claims'],
        depth: 1,
        children: []
      });
    }

    // Pages
    for (const page of (spec.pages || [])) {
      sections.push({
        title: 'Pages \\u203a ' + page.id,
        body: 'Page: ' + page.path + (page.description ? ' \\u2014 ' + page.description : ''),
        refs: ['page:' + page.id],
        depth: 1,
        children: []
      });
      for (const scenario of (page.scenarios || [])) {
        sections.push({
          title: 'Pages \\u203a ' + page.id + ' \\u203a ' + scenario.id,
          body: scenario.description || '',
          refs: ['scenario:' + page.id + '/' + scenario.id],
          depth: 2,
          children: []
        });
      }
    }

    // Flows
    for (const flow of (spec.flows || [])) {
      sections.push({
        title: 'Flows \\u203a ' + flow.id,
        body: flow.description || 'Flow with ' + flow.steps.length + ' steps',
        refs: ['flow:' + flow.id],
        depth: 1,
        children: []
      });
    }

    // CLI section
    if (spec.cli) {
      sections.push({
        title: 'CLI Verification',
        body: 'Binary: ' + spec.cli.binary + '\\n' + (spec.cli.commands || []).length + ' command tests, ' + (spec.cli.scenarios || []).length + ' scenarios',
        refs: ['cli'],
        depth: 1,
        children: []
      });
      for (const cmd of (spec.cli.commands || [])) {
        sections.push({
          title: 'CLI \\u203a ' + cmd.id,
          body: cmd.description || '',
          refs: ['cli:' + cmd.id],
          depth: 2,
          children: []
        });
      }
    }
  }

  function renderToc() {
    const toc = $('toc');
    let html = '';
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const allResults = s.refs.flatMap(r => resolveRef(r));
      const hasStale = s.refs.some(r => isStaleRef(r));
      const status = hasStale ? 'stale' : aggregateStatus(allResults);
      html += '<div class="toc-item depth-' + s.depth + (i === activeSectionIdx ? ' active' : '') + '" data-idx="' + i + '"'
        + (hasStale ? ' title="Stale reference: narrative mentions a spec item that no longer exists"' : '')
        + '>'
        + (hasStale ? '<span class="toc-status" style="background:var(--orange)" title="Stale reference"></span>' : statusIcon(status))
        + '<span>' + esc(s.title) + (hasStale ? ' \\u26a0' : '') + '</span>'
        + '</div>';
    }
    toc.innerHTML = html;

    // Bind clicks
    toc.querySelectorAll('.toc-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        selectSection(idx);
      });
    });
  }

  function renderNarrative() {
    const container = $('narrative-view');
    let html = '';
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const allResults = s.refs.flatMap(r => resolveRef(r));
      const status = aggregateStatus(allResults);
      const counts = { passed: 0, failed: 0, untested: 0 };
      allResults.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });

      const tag = s.depth === 1 ? 'h2' : 'h3';
      html += '<div class="section' + (i === activeSectionIdx ? ' active' : '') + '" data-idx="' + i + '">';
      html += '<div class="section-header">';
      html += '<' + tag + '>' + esc(s.title) + '</' + tag + '>';
      html += '<div class="section-badges">';
      if (allResults.length > 0) {
        if (counts.passed) html += badgeFor('passed', counts.passed + ' passed');
        if (counts.failed) html += badgeFor('failed', counts.failed + ' failed');
        if (counts.untested) html += badgeFor('untested', counts.untested + ' untested');
      } else {
        html += '<span class="badge badge-neutral">no tests</span>';
      }
      html += '</div></div>';

      // Body text (simple markdown-ish rendering)
      if (s.body) {
        const paragraphs = s.body.split('\\n\\n').filter(Boolean);
        html += '<div class="section-body">';
        for (const p of paragraphs) {
          html += '<p>' + esc(p) + '</p>';
        }
        html += '</div>';
      }

      // Spec refs + toggle
      if (s.refs.length > 0) {
        html += '<div class="section-refs">';
        for (const ref of s.refs) {
          const stale = isStaleRef(ref) ? ' stale' : '';
          html += '<span class="ref-tag' + stale + '">' + esc(ref) + (stale ? ' (stale)' : '') + '</span>';
        }
        html += '<button class="spec-toggle-btn" data-section-idx="' + i + '" onclick="event.stopPropagation(); toggleInlineSpec(' + i + ', this)">Show spec</button>';
        html += '</div>';
        html += '<div class="inline-spec hidden" id="inline-spec-' + i + '"></div>';
      }

      html += '</div>';
    }
    container.innerHTML = html;

    // Bind clicks
    container.querySelectorAll('.section').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        selectSection(idx);
      });
    });
  }

  // renderSpec removed — spec is now shown inline per-card via toggleInlineSpec

  // ---- Detail panel ----

  function selectSection(idx) {
    activeSectionIdx = idx;
    renderToc();
    renderNarrative();

    const s = sections[idx];
    const allResults = s.refs.flatMap(r => resolveRef(r));

    $('detail-title').textContent = s.title;
    const body = $('detail-body');

    if (allResults.length === 0) {
      var staleRefs = s.refs.filter(function(r) { return isStaleRef(r); });
      if (staleRefs.length > 0) {
        body.innerHTML = '<div class="sync-warn">\\u26a0 Stale references: the narrative mentions spec items that no longer exist: ' + staleRefs.map(function(r) { return '<code>' + esc(r) + '</code>'; }).join(', ') + '. Update the narrative to fix these.</div>';
      } else {
        body.innerHTML = '<div class="sync-warn">No validation results linked to this section. Run <code>specify verify</code> to generate results.</div>';
      }
    } else {
      let html = '';

      // Group by kind
      const groups = {};
      for (const r of allResults) {
        const k = r.kind || 'other';
        if (!groups[k]) groups[k] = [];
        groups[k].push(r);
      }

      for (const [kind, items] of Object.entries(groups)) {
        html += '<div class="detail-section">';
        html += '<div class="detail-section-title">' + esc(formatKind(kind)) + '</div>';

        for (const item of items) {
          const cls = item.status === 'passed' ? 'pass' : item.status === 'failed' ? 'fail' : 'untested';
          html += '<div class="assertion-item ' + cls + '">';

          if (item.kind === 'cli-command') {
            html += renderCliCommand(item);
          } else if (item.kind === 'request') {
            html += renderRequest(item);
          } else if (item.kind === 'visual') {
            html += renderVisual(item);
          } else if (item.kind === 'scenario' || item.kind === 'flow') {
            html += renderFlowOrScenario(item);
          } else if (item.kind === 'scenario-step' || item.kind === 'flow-step') {
            html += renderStep(item);
          } else if (item.kind === 'default') {
            html += renderDefault(item);
          } else if (item.kind === 'console') {
            html += renderConsole(item);
          } else if (item.kind === 'variable') {
            html += renderVariable(item);
          } else if (item.kind === 'assumption') {
            html += renderAssumption(item);
          } else if (item.kind === 'requirement') {
            html += renderRequirement(item);
          } else if (item.kind === 'cli-spec') {
            html += renderCliSpec(item);
          } else if (item.kind === 'cli-summary') {
            html += '<div class="assertion-type">CLI Section</div><div class="assertion-desc">Binary: ' + esc(item.binary) + '</div><div class="assertion-detail">' + item.commandCount + ' command tests</div>';
          } else {
            html += '<div class="assertion-desc">' + esc(item.description || item.status || 'Unknown') + '</div>';
          }

          html += '</div>';
        }

        html += '</div>';
      }

      body.innerHTML = html;
    }

    $('detail-panel').classList.remove('hidden');

    // Scroll to section in narrative
    const el = document.querySelector('.section[data-idx="' + idx + '"]');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeDetail() {
    activeSectionIdx = -1;
    $('detail-panel').classList.add('hidden');
    renderToc();
    renderNarrative();
  }
  window.closeDetail = closeDetail;

  function formatKind(k) {
    return k.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
  }

  function renderCliCommand(item) {
    let h = '<div class="assertion-type">CLI Command \\u2014 ' + esc(item.commandId) + '</div>';
    h += '<div class="assertion-desc">' + esc(item.description || item.commandId) + '</div>';
    if (item.args && item.args.length > 0) {
      h += '<div class="assertion-detail cli-args">' + esc((spec.cli ? spec.cli.binary : 'specify') + ' ' + item.args.join(' ')) + '</div>';
    }
    if (item.exitCode) {
      var ecIcon = item.exitCode.status === 'passed' ? '\\u2713' : '\\u2717';
      h += '<div class="assertion-detail exit-code ' + item.exitCode.status + '">' + ecIcon + ' Exit code: expected <code>' + esc(String(item.exitCode.expected)) + '</code> actual <code>' + esc(String(item.exitCode.actual)) + '</code></div>';
    }
    if (item.timedOut) {
      h += '<div class="assertion-detail" style="color:var(--red)">\\u26a0 Timed out</div>';
    }
    if (item.durationMs !== undefined) {
      h += '<div class="assertion-detail">' + item.durationMs + 'ms</div>';
    }
    var stdoutA = item.stdoutAssertions || [];
    var stderrA = item.stderrAssertions || [];
    if (stdoutA.length > 0) {
      h += '<div class="cli-assertion-group"><div class="cli-assertion-group-label">stdout assertions</div>';
      for (var ai = 0; ai < stdoutA.length; ai++) {
        h += renderCliAssertion(stdoutA[ai]);
      }
      h += '</div>';
    }
    if (stderrA.length > 0) {
      h += '<div class="cli-assertion-group"><div class="cli-assertion-group-label">stderr assertions</div>';
      for (var ai2 = 0; ai2 < stderrA.length; ai2++) {
        h += renderCliAssertion(stderrA[ai2]);
      }
      h += '</div>';
    }
    h += '<div class="cli-rerun">Re-run: <code>' + esc((spec.cli ? spec.cli.binary : './specify') + ' ' + (item.args || []).join(' ')) + '</code></div>';
    return h;
  }

  function renderCliAssertion(a) {
    var icon = a.status === 'passed' ? '\\u2713' : a.status === 'failed' ? '\\u2717' : '\\u25cb';
    var cls = a.status === 'passed' ? 'pass' : a.status === 'failed' ? 'fail' : 'untested';
    var h = '<div class="cli-assertion ' + cls + '">';
    h += '<span class="cli-assert-icon">' + icon + '</span> ';
    h += '<span class="cli-assert-type">' + esc(a.type || '') + '</span>';
    if (a.description) h += ' <span class="cli-assert-desc">' + esc(a.description) + '</span>';
    if (a.expected !== undefined) {
      h += '<div class="cli-assert-values">expected: <code>' + esc(JSON.stringify(a.expected)) + '</code>';
      if (a.actual !== undefined) {
        h += ' actual: <code>' + esc(JSON.stringify(a.actual)) + '</code>';
      }
      h += '</div>';
    }
    if (a.reason) {
      h += '<div class="cli-assert-reason">' + esc(a.reason) + '</div>';
    }
    h += '</div>';
    return h;
  }

  function renderRequest(item) {
    let h = '<div class="assertion-type">Request</div>';
    h += '<div class="assertion-desc">' + esc((item.method || '') + ' ' + (item.urlPattern || '')) + '</div>';
    if (item.description) h += '<div class="assertion-detail">' + esc(item.description) + '</div>';
    if (item.matchedUrl) h += '<div class="assertion-detail">Matched: ' + esc(item.matchedUrl) + '</div>';
    if (item.reason) h += '<div class="assertion-detail">' + esc(item.reason) + '</div>';
    return h;
  }

  function renderVisual(item) {
    let h = '<div class="assertion-type">Visual — ' + esc(item.type || '') + '</div>';
    h += '<div class="assertion-desc">' + esc(item.description || item.selector || '') + '</div>';
    if (item.reason) h += '<div class="assertion-detail">' + esc(item.reason) + '</div>';
    return h;
  }

  function renderFlowOrScenario(item) {
    let h = '<div class="assertion-type">' + esc(item.kind) + '</div>';
    h += '<div class="assertion-desc">' + esc(item.description || item.flowId || item.scenarioId || '') + '</div>';
    return h;
  }

  function renderStep(item) {
    let h = '<div class="assertion-type">Step</div>';
    h += '<div class="assertion-desc">' + esc(item.description || item.action || item.type || '') + '</div>';
    if (item.evidence) h += '<div class="assertion-detail">' + esc(item.evidence) + '</div>';
    if (item.reason) h += '<div class="assertion-detail">' + esc(item.reason) + '</div>';
    return h;
  }

  function renderDefault(item) {
    let h = '<div class="assertion-type">Default</div>';
    h += '<div class="assertion-desc">' + esc(item.property || '') + '</div>';
    if (item.details) h += '<div class="assertion-detail">' + esc(item.details) + '</div>';
    return h;
  }

  function renderConsole(item) {
    let h = '<div class="assertion-type">Console — ' + esc(item.level || '') + '</div>';
    h += '<div class="assertion-desc">' + esc(item.description || 'Console expectation') + '</div>';
    if (item.reason) h += '<div class="assertion-detail">' + esc(item.reason) + '</div>';
    return h;
  }

  function renderVariable(item) {
    var h = '<div class="assertion-type">Variable</div>';
    h += '<div class="assertion-desc">' + esc(item.name) + '</div>';
    h += '<div class="assertion-detail">' + esc(String(item.value)) + '</div>';
    return h;
  }

  function renderAssumption(item) {
    var h = '<div class="assertion-type">Assumption</div>';
    h += '<div class="assertion-desc">' + esc(item.type || item.description || '') + '</div>';
    if (item.description && item.type) h += '<div class="assertion-detail">' + esc(item.description) + '</div>';
    if (item.reason) h += '<div class="assertion-detail">' + esc(item.reason) + '</div>';
    return h;
  }

  function renderRequirement(item) {
    var h = '<div class="assertion-type">Behavioral Requirement \\u2014 ' + esc(item.verification || 'agent') + '</div>';
    h += '<div class="assertion-desc">' + esc(item.id || '') + '</div>';
    h += '<div class="assertion-detail">' + esc(item.description || '') + '</div>';
    if (item.evidence) h += '<div class="assertion-detail">Evidence: ' + esc(JSON.stringify(item.evidence).substring(0, 200)) + '</div>';
    return h;
  }

  function renderCliSpec(item) {
    var h = '<div class="assertion-type">CLI Command (untested) \\u2014 ' + esc(item.commandId) + '</div>';
    h += '<div class="assertion-desc">' + esc(item.description || item.commandId) + '</div>';
    if (item.args && item.args.length > 0) {
      h += '<div class="assertion-detail cli-args">' + esc((spec.cli ? spec.cli.binary : 'specify') + ' ' + item.args.join(' ')) + '</div>';
    }
    h += '<div class="assertion-detail">Expected exit code: <code>' + esc(String(item.expectedExitCode)) + '</code></div>';
    var stdoutA = item.stdoutAssertions || [];
    var stderrA = item.stderrAssertions || [];
    if (stdoutA.length > 0) {
      h += '<div class="cli-assertion-group"><div class="cli-assertion-group-label">stdout assertions (' + stdoutA.length + ')</div>';
      for (var i = 0; i < stdoutA.length; i++) {
        var a = stdoutA[i];
        h += '<div class="cli-assertion untested"><span class="cli-assert-icon">\\u25cb</span> <span class="cli-assert-type">' + esc(a.type || '') + '</span>';
        if (a.description) h += ' <span class="cli-assert-desc">' + esc(a.description) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    if (stderrA.length > 0) {
      h += '<div class="cli-assertion-group"><div class="cli-assertion-group-label">stderr assertions (' + stderrA.length + ')</div>';
      for (var j = 0; j < stderrA.length; j++) {
        var b = stderrA[j];
        h += '<div class="cli-assertion untested"><span class="cli-assert-icon">\\u25cb</span> <span class="cli-assert-type">' + esc(b.type || '') + '</span>';
        if (b.description) h += ' <span class="cli-assert-desc">' + esc(b.description) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '<div class="cli-rerun">Run: <code>' + esc((spec.cli ? spec.cli.binary : './specify') + ' ' + (item.args || []).join(' ')) + '</code></div>';
    return h;
  }

  // ---- Per-card spec toggle ----

  function toggleInlineSpec(idx, btn) {
    var el = $('inline-spec-' + idx);
    if (!el) return;
    var isHidden = el.classList.contains('hidden');
    if (isHidden) {
      el.innerHTML = buildInlineSpec(sections[idx]);
      el.classList.remove('hidden');
      btn.textContent = 'Hide spec';
      btn.classList.add('active');
    } else {
      el.classList.add('hidden');
      btn.textContent = 'Show spec';
      btn.classList.remove('active');
    }
  }
  window.toggleInlineSpec = toggleInlineSpec;

  function buildInlineSpec(section) {
    var lines = [];
    for (var ri = 0; ri < section.refs.length; ri++) {
      var ref = section.refs[ri];
      var refParts = ref.split(':');
      var refType = refParts[0];

      if (ref === 'overview') {
        if (spec.description) {
          lines.push('<span class="spec-key">description:</span> <span class="spec-val">' + esc(spec.description.substring(0, 200)) + (spec.description.length > 200 ? '...' : '') + '</span>');
        }
      } else if (ref === 'defaults' && spec.defaults) {
        lines.push('<span class="spec-key">defaults:</span>');
        Object.entries(spec.defaults).forEach(function(e) {
          lines.push('  <span class="spec-key">' + esc(e[0]) + ':</span> <span class="spec-val">' + esc(String(e[1])) + '</span>');
        });
      } else if (ref === 'variables' && spec.variables) {
        lines.push('<span class="spec-key">variables:</span>');
        Object.entries(spec.variables).forEach(function(e) {
          lines.push('  <span class="spec-key">' + esc(e[0]) + ':</span> <span class="spec-val">' + esc(String(e[1])) + '</span>');
        });
      } else if (ref === 'assumptions' && spec.assumptions) {
        lines.push('<span class="spec-key">assumptions:</span>');
        spec.assumptions.forEach(function(a) {
          lines.push('  - <span class="spec-key">type:</span> <span class="spec-val">' + esc(a.type) + '</span>');
          if (a.description) lines.push('    <span class="spec-key">description:</span> <span class="spec-val">' + esc(a.description) + '</span>');
        });
      } else if (ref === 'requirements' && spec.requirements) {
        lines.push('<span class="spec-key">requirements:</span>');
        spec.requirements.forEach(function(r) {
          lines.push('  - <span class="spec-key">id:</span> <span class="spec-val">' + esc(r.id) + '</span>');
          lines.push('    <span class="spec-key">description:</span> <span class="spec-val">' + esc(r.description || '') + '</span>');
          lines.push('    <span class="spec-key">verification:</span> <span class="spec-val">' + esc(r.verification || 'agent') + '</span>');
        });
      } else if (ref === 'claims' && spec.claims) {
        lines.push('<span class="spec-key">claims:</span>');
        spec.claims.forEach(function(c) {
          lines.push('  - <span class="spec-key">id:</span> <span class="spec-val">' + esc(c.id) + '</span>');
          lines.push('    <span class="spec-key">description:</span> <span class="spec-val">' + esc(c.description || '') + '</span>');
        });
      } else if (ref === 'cli' && spec.cli) {
        lines.push('<span class="spec-key">cli:</span>');
        lines.push('  <span class="spec-key">binary:</span> <span class="spec-val">' + esc(spec.cli.binary) + '</span>');
        lines.push('  <span class="spec-comment"># ' + (spec.cli.commands || []).length + ' commands, ' + (spec.cli.scenarios || []).length + ' scenarios</span>');
      } else if (refType === 'claim' && refParts.length > 1 && spec.claims) {
        var claimId = refParts.slice(1).join(':');
        var specClaim = (spec.claims || []).find(function(c) { return c.id === claimId; });
        if (specClaim) {
          lines.push('<span class="spec-key">- id:</span> <span class="spec-val">' + esc(specClaim.id) + '</span>');
          lines.push('  <span class="spec-key">description:</span> <span class="spec-val">' + esc(specClaim.description) + '</span>');
        }
      } else if (refType === 'cli' && refParts.length > 1 && spec.cli) {
        var cid = refParts.slice(1).join(':');
        var specCmd = (spec.cli.commands || []).find(function(c) { return c.id === cid; });
        if (specCmd) {
          lines.push('<span class="spec-key">- id:</span> <span class="spec-val">' + esc(specCmd.id) + '</span>');
          if (specCmd.description) lines.push('  <span class="spec-key">description:</span> <span class="spec-val">' + esc(specCmd.description.substring(0, 120)) + (specCmd.description.length > 120 ? '...' : '') + '</span>');
          lines.push('  <span class="spec-key">args:</span> <span class="spec-val">[' + (specCmd.args || []).map(function(a) { return JSON.stringify(a); }).join(', ') + ']</span>');
          lines.push('  <span class="spec-key">expected_exit_code:</span> <span class="spec-val">' + esc(String(specCmd.expected_exit_code)) + '</span>');
          if (specCmd.stdout_assertions && specCmd.stdout_assertions.length > 0) {
            lines.push('  <span class="spec-key">stdout_assertions:</span> <span class="spec-comment"># ' + specCmd.stdout_assertions.length + ' assertions</span>');
            specCmd.stdout_assertions.forEach(function(a) {
              lines.push('    - <span class="spec-key">type:</span> <span class="spec-val">' + esc(a.type) + '</span>');
              if (a.description) lines.push('      <span class="spec-key">description:</span> <span class="spec-val">' + esc(a.description.substring(0, 100)) + (a.description.length > 100 ? '...' : '') + '</span>');
            });
          }
          if (specCmd.stderr_assertions && specCmd.stderr_assertions.length > 0) {
            lines.push('  <span class="spec-key">stderr_assertions:</span> <span class="spec-comment"># ' + specCmd.stderr_assertions.length + ' assertions</span>');
          }
        }
      } else if (refType === 'page' && refParts[1]) {
        var page = (spec.pages || []).find(function(p) { return p.id === refParts[1]; });
        if (page) {
          lines.push('<span class="spec-key">- id:</span> <span class="spec-val">' + esc(page.id) + '</span>');
          lines.push('  <span class="spec-key">path:</span> <span class="spec-val">' + esc(page.path) + '</span>');
          if (page.description) lines.push('  <span class="spec-key">description:</span> <span class="spec-val">' + esc(page.description) + '</span>');
          if (page.scenarios) lines.push('  <span class="spec-comment"># ' + page.scenarios.length + ' scenarios</span>');
        }
      } else if (refType === 'flow' && refParts[1]) {
        var flow = (spec.flows || []).find(function(f) { return f.id === refParts[1]; });
        if (flow) {
          lines.push('<span class="spec-key">- id:</span> <span class="spec-val">' + esc(flow.id) + '</span>');
          if (flow.description) lines.push('  <span class="spec-key">description:</span> <span class="spec-val">' + esc(flow.description) + '</span>');
          lines.push('  <span class="spec-key">steps:</span> <span class="spec-comment"># ' + (flow.steps || []).length + ' steps</span>');
        }
      }

      if (ri < section.refs.length - 1 && lines.length > 0) {
        lines.push('');
      }
    }
    return lines.join('\\n');
  }

  // ---- Summary badges ----

  function renderSummary() {
    const badges = $('summary-badges');
    const reports = [webReport, cliReport].filter(Boolean);
    if (reports.length === 0) {
      badges.innerHTML = '<span class="badge badge-neutral">No reports</span>';
      return;
    }
    let total = 0, passed = 0, failed = 0;
    for (const r of reports) {
      if (r.summary) {
        total += r.summary.total || 0;
        passed += r.summary.passed || 0;
        failed += r.summary.failed || 0;
      }
    }
    const untested = total - passed - failed;
    let html = '';
    if (passed) html += badgeFor('passed', passed + ' passed');
    if (failed) html += badgeFor('failed', failed + ' failed');
    if (untested > 0) html += badgeFor('untested', untested + ' untested');
    if (total > 0) {
      const pct = Math.round((passed / total) * 100);
      html += '<span class="badge badge-neutral">' + pct + '% coverage</span>';
    }
    badges.innerHTML = html;
  }

  // ---- Init ----

  function init() {
    $('spec-title').textContent = spec.name;
    $('spec-version').textContent = 'v' + spec.version;

    if (narrative) {
      buildFromNarrative();
    } else {
      buildFromSpec();
    }

    renderToc();
    renderNarrative();
    renderSummary();
  }

  init();
})();
`;
