/**
 * src/review/generator.ts — Generate a self-contained HTML spec browser
 *
 * Produces a single HTML file with embedded data (spec, narrative, reports)
 * and vanilla JS for interactivity. No external dependencies at runtime.
 */

import type { Spec } from '../spec/types.js';
import type { NarrativeDocument } from '../spec/narrative.js';

export interface AgentVerifyResult {
  pass: boolean;
  summary: string;
  results: { id: string; pass: boolean; evidence: string; type?: string }[];
}

export interface ReviewData {
  spec: Spec;
  narrative?: NarrativeDocument;
  agentResult?: AgentVerifyResult;
}

export function generateReviewHtml(data: ReviewData): string {
  const spec = data.spec;
  const jsonPayload = JSON.stringify(data, null, 2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.name)} — Specify</title>
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
  </div>
</div>
<script>
// Embedded data
const DATA = ${jsonPayload};
</script>
<script>
${JS_V2}
</script>
</body>
</html>`;
}

const JS_V2 = `
(function() {
  'use strict';

  var spec = DATA.spec;
  var agentResult = DATA.agentResult;
  var areas = spec.areas || [];

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function $(id) { return document.getElementById(id); }

  // ---- Behavior status from agent results ----

  function getBehaviorStatus(areaId, behaviorId) {
    var fqid = areaId + '/' + behaviorId;
    if (agentResult && agentResult.results) {
      for (var i = 0; i < agentResult.results.length; i++) {
        var r = agentResult.results[i];
        if (r.id === fqid || r.id === behaviorId) {
          return r.pass ? 'passed' : 'failed';
        }
      }
    }
    return 'untested';
  }

  function getAreaStatus(area) {
    var hasPass = false, hasFail = false;
    for (var i = 0; i < area.behaviors.length; i++) {
      var s = getBehaviorStatus(area.id, area.behaviors[i].id);
      if (s === 'passed') hasPass = true;
      if (s === 'failed') hasFail = true;
    }
    if (hasFail) return hasPass ? 'mixed' : 'failed';
    if (hasPass) return 'passed';
    return 'untested';
  }

  function statusDot(status) {
    var cls = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : status === 'mixed' ? 'mixed' : 'untested';
    return '<span class="toc-status ' + cls + '"></span>';
  }

  function badgeFor(status, label) {
    var cls = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'untested';
    return '<span class="badge badge-' + cls + '">' + esc(label) + '</span>';
  }

  function getBehaviorEvidence(areaId, behaviorId) {
    var fqid = areaId + '/' + behaviorId;
    if (agentResult && agentResult.results) {
      for (var i = 0; i < agentResult.results.length; i++) {
        var r = agentResult.results[i];
        if (r.id === fqid || r.id === behaviorId) {
          return r.evidence || null;
        }
      }
    }
    return null;
  }

  // ---- Active area for accordion ----

  var activeAreaIdx = -1;

  function toggleArea(idx) {
    activeAreaIdx = (activeAreaIdx === idx) ? -1 : idx;
    renderToc();
    renderContent();
    if (activeAreaIdx >= 0) {
      var el = document.querySelector('.section[data-idx="' + activeAreaIdx + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ---- TOC (sidebar) ----

  function renderToc() {
    var html = '';
    for (var i = 0; i < areas.length; i++) {
      var area = areas[i];
      var status = getAreaStatus(area);
      var isActive = i === activeAreaIdx;
      html += '<div class="toc-item depth-1' + (isActive ? ' active' : '') + '" data-idx="' + i + '">';
      html += statusDot(status);
      html += '<span>' + esc(area.name) + '</span>';
      html += '</div>';
    }
    $('toc').innerHTML = html;
    $('toc').querySelectorAll('.toc-item').forEach(function(el) {
      el.addEventListener('click', function() {
        toggleArea(parseInt(el.dataset.idx));
      });
    });
  }

  // ---- Main content ----

  function renderContent() {
    var html = '';

    // Description at top
    if (spec.description) {
      html += '<div class="section" style="border-color:var(--border)">';
      html += '<div class="section-body" style="padding:20px 24px">';
      html += '<p>' + esc(spec.description) + '</p>';
      html += '</div></div>';
    }

    for (var i = 0; i < areas.length; i++) {
      var area = areas[i];
      var isExpanded = i === activeAreaIdx;
      var areaStatus = getAreaStatus(area);
      var counts = { passed: 0, failed: 0, untested: 0 };
      for (var bi = 0; bi < area.behaviors.length; bi++) {
        var bs = getBehaviorStatus(area.id, area.behaviors[bi].id);
        if (bs === 'passed') counts.passed++;
        else if (bs === 'failed') counts.failed++;
        else counts.untested++;
      }

      html += '<div class="section' + (isExpanded ? ' expanded' : '') + '" data-idx="' + i + '">';

      // Header
      html += '<div class="section-header" data-idx="' + i + '">';
      html += '<div class="section-header-left">';
      html += '<span class="section-chevron">' + (isExpanded ? '\\u25be' : '\\u25b8') + '</span>';
      html += '<h2>' + esc(area.name) + '</h2>';
      html += '<div class="section-mini-badges">';
      html += '<span class="mini-badge info">' + area.behaviors.length + ' behaviors</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="section-badges">';
      if (counts.passed) html += badgeFor('passed', counts.passed + ' passed');
      if (counts.failed) html += badgeFor('failed', counts.failed + ' failed');
      if (counts.untested) html += badgeFor('untested', counts.untested + ' untested');
      html += '</div></div>';

      // Prose
      if (area.prose) {
        html += '<div class="section-body">';
        var paragraphs = area.prose.split('\\n\\n').filter(Boolean);
        for (var pi = 0; pi < paragraphs.length; pi++) {
          html += '<p>' + esc(paragraphs[pi]) + '</p>';
        }
        html += '</div>';
      }

      // Expandable details: behavior cards
      html += '<div class="section-details">';
      html += '<div class="section-details-inner">';
      if (isExpanded) {
        html += renderAreaBehaviors(area);
      }
      html += '</div></div>';

      html += '</div>';
    }
    $('narrative-view').innerHTML = html;

    // Bind header clicks
    $('narrative-view').querySelectorAll('.section-header').forEach(function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.closest('button')) return;
        toggleArea(parseInt(el.dataset.idx));
      });
    });
  }

  function renderAreaBehaviors(area) {
    var html = '<div class="detail-section"><div class="detail-section-title">Behaviors</div>';
    for (var i = 0; i < area.behaviors.length; i++) {
      var b = area.behaviors[i];
      var status = getBehaviorStatus(area.id, b.id);
      var cls = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'untested';
      var icon = status === 'passed' ? '\\u2713' : status === 'failed' ? '\\u2717' : '\\u25cb';

      html += '<div class="req-card ' + cls + '">';
      html += '<div class="req-card-header">';
      html += '<span class="req-card-id">' + esc(area.id + '/' + b.id) + '</span>';
      html += '<div class="req-card-badges">';
      html += '<span class="req-status-icon ' + cls + '">' + icon + '</span>';
      if (status !== 'untested') {
        html += '<span class="badge badge-' + cls + '">' + esc(status) + '</span>';
      }
      html += '</div></div>';
      html += '<div class="req-card-desc">' + esc(b.description) + '</div>';

      if (b.details) {
        html += '<div class="req-plan"><div class="req-plan-title">Details</div>';
        html += '<div style="color:var(--text-muted);font-size:13px;line-height:1.5">' + esc(b.details) + '</div>';
        html += '</div>';
      }

      if (b.tags && b.tags.length > 0) {
        html += '<div class="req-card-meta">';
        for (var ti = 0; ti < b.tags.length; ti++) {
          html += '<span class="badge badge-neutral">' + esc(b.tags[ti]) + '</span>';
        }
        html += '</div>';
      }

      // Evidence from agent verification
      var evidence = getBehaviorEvidence(area.id, b.id);
      if (evidence) {
        html += '<div class="req-evidence"><div class="req-evidence-title">Evidence</div>';
        if (typeof evidence === 'string') {
          html += '<div class="spec-preview-text">' + esc(evidence) + '</div>';
        } else if (Array.isArray(evidence)) {
          for (var ei = 0; ei < evidence.length; ei++) {
            var ev = evidence[ei];
            html += '<div style="margin-bottom:4px"><span style="color:var(--accent);font-size:12px">' + esc(ev.label || ev.type || '') + ':</span> ';
            html += '<span style="color:var(--text-muted);font-size:12px">' + esc(ev.content || '') + '</span></div>';
          }
        } else if (typeof evidence === 'object') {
          var entries = Object.entries(evidence);
          for (var oi = 0; oi < entries.length; oi++) {
            html += '<div style="margin-bottom:4px"><span style="color:var(--accent);font-size:12px">' + esc(entries[oi][0]) + ':</span> ';
            html += '<span style="color:var(--text-muted);font-size:12px">' + esc(typeof entries[oi][1] === 'string' ? entries[oi][1] : JSON.stringify(entries[oi][1])) + '</span></div>';
          }
        }
        html += '</div>';
      }

      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ---- Summary badges ----

  function renderSummary() {
    var total = 0, passed = 0, failed = 0;
    for (var i = 0; i < areas.length; i++) {
      for (var j = 0; j < areas[i].behaviors.length; j++) {
        total++;
        var s = getBehaviorStatus(areas[i].id, areas[i].behaviors[j].id);
        if (s === 'passed') passed++;
        else if (s === 'failed') failed++;
      }
    }
    var untested = total - passed - failed;
    var html = '';
    if (passed) html += badgeFor('passed', passed + ' passed');
    if (failed) html += badgeFor('failed', failed + ' failed');
    if (untested > 0) html += badgeFor('untested', untested + ' untested');
    if (total > 0) {
      var pct = Math.round((passed / total) * 100);
      html += '<span class="badge badge-neutral">' + pct + '% coverage</span>';
    }
    if (!html) html = '<span class="badge badge-neutral">No behaviors</span>';
    $('summary-badges').innerHTML = html;
  }

  // ---- Init ----

  function init() {
    $('spec-title').textContent = spec.name;
    $('spec-version').textContent = 'v' + spec.version;
    renderToc();
    renderContent();
    renderSummary();
  }

  init();
})();
`;

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
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  flex: 1;
}

/* Sidebar */
#sidebar {
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
  border-right: 1px solid var(--border);
  position: sticky;
  top: var(--header-h);
  height: calc(100vh - var(--header-h));
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
  overflow-y: auto;
  padding: 32px 48px;
  max-width: 960px;
}

.section {
  margin-bottom: 32px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-surface);
  transition: border-color 0.15s;
  overflow: hidden;
}
.section:hover { border-color: var(--accent); }
.section.expanded { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  cursor: pointer;
  transition: background 0.15s;
}
.section-header:hover { background: var(--bg-hover); }
.section-header h2 { font-size: 18px; font-weight: 600; }
.section-header h3 { font-size: 15px; font-weight: 600; }
.section-chevron {
  font-size: 14px;
  color: var(--text-muted);
  margin-right: 8px;
  transition: transform 0.2s;
  flex-shrink: 0;
}
.section.expanded .section-chevron { transform: rotate(90deg); }
.section-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.section-header-left h2, .section-header-left h3 {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.section-badges { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.section-mini-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-left: 4px; }
.mini-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}
.mini-badge.pass { background: rgba(63,185,80,0.12); color: var(--green); }
.mini-badge.fail { background: rgba(248,81,73,0.12); color: var(--red); }
.mini-badge.untested { background: rgba(110,118,129,0.12); color: var(--text-dim); }
.mini-badge.info { background: rgba(88,166,255,0.1); color: var(--accent); }

.section-body { color: var(--text-muted); font-size: 14px; padding: 0 24px; }
.section-body:last-child { padding-bottom: 20px; }
.section-body p { margin-bottom: 8px; }
.section-refs {
  margin-top: 8px;
  padding: 0 24px;
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

/* Accordion details */
.section-details {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease-out;
  background: rgba(0,0,0,0.12);
  border-top: 1px solid transparent;
}
.section.expanded .section-details {
  max-height: 5000px;
  transition: max-height 0.5s ease-in;
  border-top-color: var(--border);
}
.section-details-inner {
  padding: 16px 24px 20px;
}
.section-details .agent-result-item {
  padding: 8px 12px;
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 13px;
}
.section-details .agent-result-item.pass { border-left: 3px solid var(--green); }
.section-details .agent-result-item.fail { border-left: 3px solid var(--red); }
.section-details .not-verified {
  color: var(--text-dim);
  font-size: 13px;
  font-style: italic;
  padding: 8px 0;
}

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
  margin: 12px 24px 0;
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

/* Requirement cards */
.req-card {
  padding: 12px 16px;
  margin-bottom: 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(0,0,0,0.15);
  transition: border-color 0.15s;
}
.req-card:hover { border-color: var(--accent); }
.req-card.pass { border-left: 3px solid var(--green); }
.req-card.fail { border-left: 3px solid var(--red); }
.req-card.untested { border-left: 3px solid var(--text-dim); }

.req-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.req-card-id {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  font-family: 'SFMono-Regular', Consolas, monospace;
}
.req-card-badges { display: flex; gap: 6px; align-items: center; }
.req-card-desc {
  font-size: 14px;
  color: var(--text);
  margin-bottom: 8px;
  line-height: 1.5;
}
.req-card-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.req-plan {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(0,0,0,0.2);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.req-plan-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.req-plan ol {
  margin: 0;
  padding-left: 18px;
}
.req-plan ol li {
  margin-bottom: 2px;
  line-height: 1.5;
}
.req-evidence {
  margin-top: 6px;
  padding: 8px 12px;
  background: rgba(0,0,0,0.2);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.req-evidence-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 4px;
}
.req-status-icon {
  font-size: 14px;
  margin-right: 4px;
}
.req-status-icon.pass { color: var(--green); }
.req-status-icon.fail { color: var(--red); }
.req-status-icon.untested { color: var(--text-dim); }

/* Detail empty state with spec data */
.spec-preview-item {
  padding: 8px 12px;
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 13px;
}
.spec-preview-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  margin-bottom: 2px;
}
.spec-preview-text { color: var(--text-muted); }
.spec-preview-list {
  margin: 4px 0 0 0;
  padding-left: 16px;
  color: var(--text-muted);
  font-size: 12px;
}
.spec-preview-list li { margin-bottom: 2px; }

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
  #layout { grid-template-columns: 1fr; }
  #sidebar { display: none; }
  #content { padding: 16px; }
}
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
