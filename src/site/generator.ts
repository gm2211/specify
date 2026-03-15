/**
 * src/site/generator.ts — Generate a self-contained HTML spec browser
 *
 * Produces a single HTML file with embedded data (spec, narrative, reports)
 * and vanilla JS for interactivity. No external dependencies at runtime.
 */

import type { Spec } from '../spec/types.js';
import type { NarrativeDocument } from '../spec/narrative.js';
import type { GapReport } from '../validation/types.js';
import type { CliGapReport } from '../cli-test/types.js';

export interface SiteData {
  spec: Spec;
  narrative?: NarrativeDocument;
  webReport?: GapReport;
  cliReport?: CliGapReport;
}

export function generateSiteHtml(data: SiteData): string {
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
      <div class="toggle-group">
        <button id="btn-narrative" class="toggle-btn active" onclick="setView('narrative')">Narrative</button>
        <button id="btn-spec" class="toggle-btn" onclick="setView('spec')">Spec</button>
      </div>
      <div id="summary-badges"></div>
    </div>
  </header>
  <div id="layout">
    <nav id="sidebar">
      <div id="toc"></div>
    </nav>
    <main id="content">
      <div id="narrative-view"></div>
      <div id="spec-view" class="hidden"></div>
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

/* Spec view */
#spec-view {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 20px 24px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
}

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
      if (webReport && webReport.defaults) {
        webReport.defaults.forEach(d => results.push({ kind: 'default', ...d }));
      }
    }

    // CLI report — match by command ID pattern
    if (cliReport) {
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
    for (const page of (spec.pages || [])) {
      sections.push({
        title: page.id,
        body: 'Page: ' + page.path + (page.description ? ' — ' + page.description : ''),
        refs: ['page:' + page.id],
        depth: 1,
        children: []
      });
      for (const scenario of (page.scenarios || [])) {
        sections.push({
          title: scenario.id,
          body: scenario.description || '',
          refs: ['scenario:' + page.id + '/' + scenario.id],
          depth: 2,
          children: []
        });
      }
    }
    for (const flow of (spec.flows || [])) {
      sections.push({
        title: flow.id,
        body: flow.description || 'Flow with ' + flow.steps.length + ' steps',
        refs: ['flow:' + flow.id],
        depth: 1,
        children: []
      });
    }
  }

  function renderToc() {
    const toc = $('toc');
    let html = '';
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const allResults = s.refs.flatMap(r => resolveRef(r));
      const status = aggregateStatus(allResults);
      html += '<div class="toc-item depth-' + s.depth + (i === activeSectionIdx ? ' active' : '') + '" data-idx="' + i + '">'
        + statusIcon(status)
        + '<span>' + esc(s.title) + '</span>'
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

      // Spec refs
      if (s.refs.length > 0) {
        html += '<div class="section-refs">';
        for (const ref of s.refs) {
          html += '<span class="ref-tag">' + esc(ref) + '</span>';
        }
        html += '</div>';
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

  function renderSpec() {
    const container = $('spec-view');
    // Pretty-print the spec as indented JSON (YAML would need a lib)
    container.textContent = JSON.stringify(spec, null, 2);
  }

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
      body.innerHTML = '<div class="sync-warn">No validation results linked to this section.</div>';
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
    let h = '<div class="assertion-type">CLI Command</div>';
    h += '<div class="assertion-desc">' + esc(item.description || item.commandId) + '</div>';
    if (item.exitCode) {
      h += '<div class="assertion-detail">Exit: expected=' + item.exitCode.expected + ' actual=' + item.exitCode.actual + ' ' + item.exitCode.status + '</div>';
    }
    const allAssertions = (item.stdoutAssertions || []).concat(item.stderrAssertions || []);
    for (const a of allAssertions) {
      const icon = a.status === 'passed' ? '\\u2713' : a.status === 'failed' ? '\\u2717' : '\\u25cb';
      h += '<div class="assertion-detail">' + icon + ' ' + esc(a.description || a.type || '') + '</div>';
    }
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

  // ---- View toggle ----

  function setView(view) {
    $('btn-narrative').classList.toggle('active', view === 'narrative');
    $('btn-spec').classList.toggle('active', view === 'spec');
    $('narrative-view').classList.toggle('hidden', view !== 'narrative');
    $('spec-view').classList.toggle('hidden', view !== 'spec');
  }
  window.setView = setView;

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
    renderSpec();
    renderSummary();
  }

  init();
})();
`;
