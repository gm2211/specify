/**
 * src/report/proof-html.ts — Pure HTML renderer for `specify prove`
 *
 * Turns a fully-assembled ProofInput (built by src/report/proof-loader.ts from
 * a verify output directory) into one self-contained proof.html string. This
 * module does no filesystem or path work — it is a pure function of its
 * input, which keeps it trivially testable and keeps the untrusted-content
 * question in one place: every piece of spec- or agent-authored text that
 * ends up in the page goes through `escapeHtml` before interpolation.
 *
 * XSS invariant: the agent that produced a verify run is not fully trusted —
 * its narration (behavior descriptions, evidence content, rationale, trace
 * descriptions, …) is attacker-controllable in the same sense any LLM output
 * is. So:
 *   - Server-side (this file): every such string is escaped with escapeHtml
 *     before being placed in HTML text or in a quoted attribute.
 *   - The embedded JSON payload goes through escapeJsonForScript so `</script>`
 *     cannot break out of the <script type="application/json"> element.
 *   - Client-side (PROOF_JS below): the inline script only ever assigns
 *     textContent and img.src from the validated #shot-store map — it never
 *     uses innerHTML on anything derived from the payload.
 */

import type {
  BehaviorResult,
  GuaranteeCheck,
  MonitorVerdict,
} from '../spec/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProofProvenance = 'runner-recorded' | 'agent-reported';

export interface ProofInput {
  generator: { version: string; generatedAt: string; commandLine: string };
  spec: { name: string; version: string; description?: string; path: string };
  target: { type: 'web' | 'cli' | 'api'; url?: string; binary?: string };
  run: {
    timestamp: string;
    pass: boolean;
    summary: { total: number; passed: number; failed: number; skipped: number; untested: number };
  };
  areas: ProofArea[];
  /** Every unique screenshot referenced anywhere, keyed by basename. Emitted once each. */
  screenshots: Record<string, ProofScreenshot>;
  /** Full runner-recorded web film (all observations with an on-disk screenshot). */
  sessionFrames: ProofFrame[];
  /** Full runner-recorded CLI session, in step order. Empty for web/api targets. */
  cliSession: ProofCliStep[];
  integrity: ProofIntegrity;
}

export interface ProofArea {
  id: string;
  name: string;
  prose?: string;
  behaviors: ProofBehavior[];
}

export interface ProofBehavior {
  id: string; // fully-qualified "area/behavior"
  description: string;
  details?: string;
  status: 'passed' | 'failed' | 'skipped' | 'untested';
  method?: string;
  rationale?: string;
  durationMs?: number;
  verdictSource?: BehaviorResult['verdict_source'];
  guaranteeSource?: BehaviorResult['guarantee_source'];
  repro?: { test?: string; confirmed: boolean; output: string };
  monitor: MonitorVerdict[];
  guarantees: GuaranteeCheck[];
  evidence: ProofEvidenceItem[];
  trace: ProofTraceStep[];
  frames: ProofFrame[]; // per-behavior filmstrip (web/api)
  cliSteps: ProofCliStep[]; // per-behavior terminal replays (cli)
  filmstripNote?: string; // set when no per-behavior filmstrip could be derived
  counts: { runnerRecorded: number; agentReported: number };
}

export interface ProofEvidenceItem {
  type: 'screenshot' | 'text' | 'network_log' | 'command_output' | 'file';
  label: string;
  content: string; // the agent's claim -> "Expected / claimed"
  provenance: ProofProvenance;
  observationStep?: number; // only when runner-recorded and a step resolved
  matchReason: string; // one sentence; badge tooltip
  screenshotKey?: string; // basename key into ProofInput.screenshots
  actual?: ProofEvidenceActual; // runner-recorded counterpart -> "Actual"
}

export type ProofEvidenceActual =
  | { kind: 'cli'; step: number; argv: string[]; stdout: string; stderr: string; exitCode: number | null; signal?: string }
  | { kind: 'screenshot'; key: string; step?: number; url?: string }
  | { kind: 'scripted' };

export interface ProofTraceStep {
  type: 'navigation' | 'click' | 'fill' | 'screenshot' | 'observation' | 'assertion' | 'wait' | 'other';
  description: string;
  timestamp?: string;
  screenshotKey?: string;
  provenance: ProofProvenance;
  observationStep?: number;
}

export interface ProofFrame {
  key: string;
  caption: string;
  source: 'action_trace' | 'observation';
  observationStep?: number;
  timestamp?: string;
  url?: string;
}

export interface ProofCliStep {
  step: number;
  argv: string[];
  cwd: string;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal?: string;
  durationMs: number;
  tsStart: number;
  tsEnd: number;
  error?: string;
}

export type ProofScreenshot =
  | { kind: 'inline'; dataUri: string; bytes: number; encodedBytes: number }
  | { kind: 'link'; href: string; bytes: number }; // relative POSIX href from the output file's dir

export interface ProofSourceFile {
  path: string;
  present: boolean;
  sha256?: string;
  bytes?: number;
  mtime?: string;
}

export interface ProofIntegrity {
  inputDir: string;
  outputPath: string;
  files: ProofSourceFile[];
  screenshotsEmbedded: number;
  screenshotsLinked: number;
  screenshotEncodedBytes: number;
  screenshotByteCap: number;
  generatorVersion: string;
  generatedAt: string;
  regenerateCommand: string;
}

export const PROOF_FRAME_MS = 1200;
export const PROOF_LINE_MS = 30;

// ---------------------------------------------------------------------------
// Escaping — the single choke point for untrusted text
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Built via String.fromCharCode rather than literal escapes so the source
// file never contains a raw U+2028/U+2029 — those are line terminators in
// JS/TS source text and cannot appear unescaped inside a regex literal.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029');
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function slugId(fqId: string): string {
  return 'b-' + fqId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = n;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function pct(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 10000) / 100;
}

function statusLabel(status: ProofBehavior['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ---------------------------------------------------------------------------
// Top-level render
// ---------------------------------------------------------------------------

export function renderProofHtml(input: ProofInput): string {
  const payload = {
    frameMs: PROOF_FRAME_MS,
    lineMs: PROOF_LINE_MS,
    films: {
      ...Object.fromEntries(
        input.areas.flatMap((area) =>
          area.behaviors
            .filter((b) => b.frames.length > 0)
            .map((b) => [
              slugId(b.id),
              b.frames.map((f) => ({ key: f.key, caption: f.caption, step: f.observationStep, url: f.url, source: f.source })),
            ]),
        ),
      ),
      session: input.sessionFrames.map((f) => ({ key: f.key, caption: f.caption, step: f.observationStep, url: f.url, source: f.source })),
    },
  };
  const payloadJson = escapeJsonForScript(JSON.stringify(payload));

  const bodySections = [
    renderHeader(input),
    '<main>',
    input.areas.map((area) => renderArea(area)).join('\n'),
    renderRecordedSession(input),
    '</main>',
    renderIntegrity(input.integrity),
  ].join('\n');

  const shotStore = renderShotStore(input.screenshots);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proof of validation — ${escapeHtml(input.spec.name)}</title>
<style>${PROOF_CSS}</style>
</head>
<body>
${bodySections}
${shotStore}
<script type="application/json" id="proof-data">${payloadJson}</script>
<script>${PROOF_JS}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Shot store
// ---------------------------------------------------------------------------

function renderShotStore(screenshots: Record<string, ProofScreenshot>): string {
  const imgs = Object.entries(screenshots)
    .map(([key, shot]) => {
      const src = shot.kind === 'inline' ? shot.dataUri : shot.href;
      return `<img data-key="${escapeHtml(key)}" src="${escapeHtml(src)}" alt="">`;
    })
    .join('\n');
  return `<div id="shot-store" hidden aria-hidden="true">\n${imgs}\n</div>`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(input: ProofInput): string {
  const { run, spec, target, generator } = input;
  const verdictClass = run.pass ? 'verdict--pass' : 'verdict--fail';
  const verdictLabel = run.pass ? 'PASS' : 'FAIL';

  const targetValue = target.url ?? target.binary ?? '';
  const segs: { key: keyof typeof run.summary; label: string }[] = [
    { key: 'passed', label: 'passed' },
    { key: 'failed', label: 'failed' },
    { key: 'skipped', label: 'skipped' },
    { key: 'untested', label: 'untested' },
  ];
  const total = run.summary.total;
  const segsHtml = segs
    .map((s) => `<span class="progress-seg progress-seg--${s.key}" style="width:${pct(run.summary[s.key], total).toFixed(2)}%"></span>`)
    .join('');
  const ariaLabel = `${run.summary.passed} passed, ${run.summary.failed} failed, ${run.summary.skipped} skipped, ${run.summary.untested} untested of ${total} behaviors`;

  const countsHtml = segs
    .map((s) => `<span class="count count--${s.key}"><b>${run.summary[s.key]}</b> ${s.label}</span>`)
    .join('');

  return `<header class="proof-header">
  <h1>Proof of validation <span class="verdict ${verdictClass}">${verdictLabel}</span></h1>
  <dl class="ph-meta">
    <div><dt>Spec</dt><dd>${escapeHtml(spec.name)} <code>v${escapeHtml(spec.version)}</code></dd></div>
    <div><dt>Target</dt><dd><span class="chip chip--${escapeHtml(target.type)}">${escapeHtml(target.type)}</span> <code>${escapeHtml(targetValue)}</code></dd></div>
    <div><dt>Run</dt><dd>${run.timestamp ? `<time datetime="${escapeHtml(run.timestamp)}">${escapeHtml(run.timestamp)}</time>` : '<span class="dim">not recorded</span>'}</dd></div>
    <div><dt>Generated</dt><dd>${escapeHtml(generator.generatedAt)} · specify ${escapeHtml(generator.version)}</dd></div>
  </dl>
  <div class="progress" role="img" aria-label="${escapeHtml(ariaLabel)}">${segsHtml}</div>
  <p class="counts">${countsHtml}<span class="count count--total"><b>${total}</b> total</span></p>
</header>`;
}

// ---------------------------------------------------------------------------
// Area / behavior
// ---------------------------------------------------------------------------

function renderArea(area: ProofArea): string {
  return `<section class="area" id="area-${escapeHtml(slugId(area.id))}">
  <h2>${escapeHtml(area.name)}</h2>
  ${area.prose ? `<p class="area-prose">${escapeHtml(area.prose)}</p>` : ''}
  ${area.behaviors.map((b) => renderBehavior(b)).join('\n')}
</section>`;
}

function renderBehavior(b: ProofBehavior): string {
  const slug = slugId(b.id);
  const dot = `<span class="dot dot--${b.status}"></span>`;
  const badge = `<span class="badge badge--${b.status}">${statusLabel(b.status)}</span>`;

  let verdictBadge = '';
  if (b.verdictSource) {
    const title = `Verdict source: ${b.verdictSource}`;
    verdictBadge = `<span class="badge badge--verdict" title="${escapeHtml(title)}">${escapeHtml(b.verdictSource)}</span>`;
  } else if (b.guaranteeSource) {
    const title = `Guarantee source: ${b.guaranteeSource}`;
    verdictBadge = `<span class="badge badge--verdict" title="${escapeHtml(title)}">${escapeHtml(b.guaranteeSource)}</span>`;
  }

  let reproBadge = '';
  if (b.repro) {
    const cls = b.repro.confirmed ? 'badge--repro-confirmed' : 'badge--repro-unconfirmed';
    const label = b.repro.confirmed ? 'repro confirmed' : 'repro unconfirmed';
    reproBadge = `<span class="badge ${cls}" title="${escapeHtml(b.repro.output)}">${label}</span>`;
  }

  const duration = b.durationMs !== undefined ? `<span class="b-duration">${escapeHtml(formatDuration(b.durationMs))}</span>` : '';

  const desc = `<p class="b-desc">${escapeHtml(b.description)}</p>`;
  const details = b.details ? `<p class="b-details">${escapeHtml(b.details)}</p>` : '';
  const method = b.method ? `<p class="b-method"><span class="k">Method</span> ${escapeHtml(b.method)}</p>` : '';
  const rationale = b.rationale ? `<p class="b-rationale">${escapeHtml(b.rationale)}</p>` : '';

  return `<article class="behavior behavior--${b.status}" id="${escapeHtml(slug)}">
  <div class="b-head">
    ${dot}<code class="b-id">${escapeHtml(b.id)}</code>${badge}${verdictBadge}${reproBadge}${duration}
  </div>
  ${desc}${details}${method}${rationale}
  ${renderMonitorAndGuarantees(b)}
  ${renderEvidence(b, slug)}
  ${renderTrace(b)}
  ${renderFilm(b, slug)}
  ${renderTerminalSteps(b.cliSteps)}
</article>`;
}

function renderMonitorAndGuarantees(b: ProofBehavior): string {
  if (b.monitor.length === 0 && b.guarantees.length === 0) return '';
  const monitorItems = b.monitor
    .map(
      (m) =>
        `<li class="monitor-item monitor-item--${escapeHtml(m.verdict)}"><code>${escapeHtml(m.formula_id)}</code> — ${escapeHtml(m.verdict)}${m.witness_detail ? `: ${escapeHtml(m.witness_detail)}` : ''}</li>`,
    )
    .join('');
  const guaranteeItems = b.guarantees
    .map(
      (g) =>
        `<li class="guarantee-item guarantee-item--${escapeHtml(g.verdict)}"><code>${escapeHtml(g.guarantee)}</code> (${escapeHtml(g.entity)}) — ${escapeHtml(g.verdict)}: ${escapeHtml(g.detail)}${g.inconclusiveReason ? ` (${escapeHtml(g.inconclusiveReason)})` : ''}</li>`,
    )
    .join('');
  return `<div class="b-checks">
    ${b.monitor.length ? `<ul class="monitor-list">${monitorItems}</ul>` : ''}
    ${b.guarantees.length ? `<ul class="guarantee-list">${guaranteeItems}</ul>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

function renderEvidence(b: ProofBehavior, slug: string): string {
  if (b.evidence.length === 0) return '';
  const summary = `Evidence (${b.evidence.length}) — ${b.counts.runnerRecorded} runner-recorded, ${b.counts.agentReported} agent-reported`;
  const items = b.evidence.map((ev, i) => renderEvidenceItem(ev, slug, i)).join('\n');
  return `<details class="b-block" open><summary>${escapeHtml(summary)}</summary><ul class="ev-list">${items}</ul></details>`;
}

function renderEvidenceItem(ev: ProofEvidenceItem, slug: string, index: number): string {
  const isRunner = ev.provenance === 'runner-recorded';
  const liClass = isRunner ? 'ev--runner' : 'ev--agent';

  let provBadge: string;
  if (isRunner) {
    const step = ev.observationStep;
    const href = step !== undefined ? `#term-${step}` : `#${escapeHtml(slug)}`;
    const stepSpan = step !== undefined ? `<span class="prov-step"> · step ${step}</span>` : '';
    provBadge = `<a class="prov prov--runner" href="${href}" title="${escapeHtml(ev.matchReason)}">runner-recorded${stepSpan}</a>`;
  } else {
    provBadge = `<span class="prov prov--agent" title="${escapeHtml(ev.matchReason)}">agent-reported</span>`;
  }

  const evHead = `<div class="ev-head"><span class="ev-type">${escapeHtml(ev.type)}</span><span class="ev-label">${escapeHtml(ev.label)}</span>${provBadge}</div>`;

  const expectedCol = `<div class="ev-col"><h4>Expected — agent's claim</h4><pre>${escapeHtml(ev.content)}</pre></div>`;

  let cols: string;
  if (ev.actual) {
    const actualCol = renderActualCol(ev.actual);
    cols = `<div class="ev-cols">${expectedCol}${actualCol}</div>`;
  } else {
    cols = `<div class="ev-cols"><div class="ev-col ev-col--single"><h4>Reported — no deterministic counterpart</h4><pre>${escapeHtml(ev.content)}</pre></div></div>`;
  }

  return `<li class="ev ev-${index} ${liClass}">${evHead}${cols}</li>`;
}

function renderActualCol(actual: ProofEvidenceActual): string {
  if (actual.kind === 'cli') {
    const exitOk = actual.exitCode === 0;
    const exitClass = exitOk ? 'exit--ok' : 'exit--err';
    const exitLabel = actual.exitCode === null ? `signal ${actual.signal ?? 'unknown'}` : `exit ${actual.exitCode}`;
    const body = [`$ ${actual.argv.join(' ')}`, actual.stdout, actual.stderr].filter((s) => s.length > 0).join('\n');
    return `<div class="ev-col"><h4>Actual — runner-recorded, step ${actual.step}</h4><pre class="ev-actual">${escapeHtml(body)}</pre><span class="exit ${exitClass}">${escapeHtml(exitLabel)}</span></div>`;
  }
  if (actual.kind === 'screenshot') {
    const stepLabel = actual.step !== undefined ? ` (step ${actual.step})` : '';
    const meta = [actual.step !== undefined ? `step ${actual.step}` : '', actual.url ?? ''].filter((s) => s.length > 0).join(' · ');
    const caption = `<p class="ev-shot-caption"><code>${escapeHtml(actual.key)}</code>${meta ? ` <span class="dim">${escapeHtml(meta)}</span>` : ''}</p>`;
    return `<div class="ev-col"><h4>Actual — runner-recorded screenshot${escapeHtml(stepLabel)}</h4><img class="ev-shot" data-key="${escapeHtml(actual.key)}" alt="${escapeHtml(actual.key)}" loading="lazy">${caption}</div>`;
  }
  return `<div class="ev-col"><h4>Actual — scripted replay</h4><p>Produced by the deterministic Playwright replay tier — no LLM in the loop.</p></div>`;
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

const TRACE_ICONS: Record<ProofTraceStep['type'], string> = {
  navigation: '→',
  click: '⦿',
  fill: '✎',
  screenshot: '⌾',
  observation: '◎',
  assertion: '✓',
  wait: '◔',
  other: '·',
};

function renderTrace(b: ProofBehavior): string {
  if (b.trace.length === 0) return '';
  const items = b.trace
    .map((step) => {
      const icon = TRACE_ICONS[step.type] ?? '·';
      const provBadge =
        step.provenance === 'runner-recorded'
          ? `<span class="prov prov--runner">runner-recorded${step.observationStep !== undefined ? ` · step ${step.observationStep}` : ''}</span>`
          : `<span class="prov prov--agent">agent-reported</span>`;
      return `<li class="trace-step trace-step--${escapeHtml(step.type)}"><span class="trace-icon" aria-hidden="true">${icon}</span><span class="trace-type">${escapeHtml(step.type)}</span><span class="trace-desc">${escapeHtml(step.description)}</span>${provBadge}</li>`;
    })
    .join('\n');
  return `<details class="b-block" open><summary>QA trace (${b.trace.length} steps)</summary><ol class="trace">${items}</ol></details>`;
}

// ---------------------------------------------------------------------------
// Filmstrip (web/api)
// ---------------------------------------------------------------------------

function renderFilm(b: ProofBehavior, slug: string): string {
  if (b.frames.length === 0) {
    if (b.filmstripNote) {
      return `<p class="film-note">${escapeHtml(b.filmstripNote)}</p>`;
    }
    return '';
  }
  return renderFilmSection(`${slug}`, b.frames, `Screenshot filmstrip for ${b.id}`);
}

function renderFilmSection(dataFilm: string, frames: ProofFrame[], ariaLabel: string): string {
  const thumbs = frames
    .map(
      (f, i) =>
        `<li><button class="film-thumb" data-index="${i}" type="button"><img data-key="${escapeHtml(f.key)}" alt="" loading="lazy"></button></li>`,
    )
    .join('');
  return `<section class="film" data-film="${escapeHtml(dataFilm)}" tabindex="0" aria-label="${escapeHtml(ariaLabel)}">
    <div class="film-stage"><img class="film-img" alt=""></div>
    <p class="film-caption"></p>
    <p class="film-meta"></p>
    <div class="film-controls">
      <button class="film-prev" type="button" aria-label="Previous frame">‹</button>
      <button class="film-play" type="button" aria-pressed="false">▶ Play</button>
      <button class="film-next" type="button" aria-label="Next frame">›</button>
      <span class="film-counter">1 / ${frames.length}</span>
    </div>
    <ol class="film-thumbs">${thumbs}</ol>
    <noscript>Screenshots require JavaScript; the source files are under capture/screenshots/.</noscript>
  </section>`;
}

// ---------------------------------------------------------------------------
// Terminal replay (cli)
// ---------------------------------------------------------------------------

function renderTerminalSteps(steps: ProofCliStep[]): string {
  if (steps.length === 0) return '';
  return steps.map((s) => renderTerminal(s)).join('\n');
}

function renderTerminal(step: ProofCliStep): string {
  const exitOk = step.exitCode === 0;
  const exitClass = exitOk ? 'exit--ok' : 'exit--err';
  const exitLabel = step.exitCode === null ? `signal ${step.signal ?? 'unknown'}` : `exit ${step.exitCode}`;
  const truncated = step.stdoutTruncated || step.stderrTruncated;
  const body = [`$ ${step.argv.join(' ')}`, step.stdout, step.stderr].filter((s) => s.length > 0).join('\n');
  return `<section class="term" id="term-${step.step}" data-term="${step.step}">
    <div class="term-head">
      <span class="term-title">step ${step.step} · <code>${escapeHtml(step.argv.join(' '))}</code></span>
      <span class="term-cwd">${escapeHtml(step.cwd)}</span>
      <span class="term-dur">${escapeHtml(formatDuration(step.durationMs))}</span>
    </div>
    <pre class="term-screen" aria-live="polite">${escapeHtml(body)}</pre>
    <div class="term-controls">
      <button class="term-replay" type="button">▶ Replay</button>
      <button class="term-skip" type="button" hidden>Skip</button>
      <span class="exit ${exitClass}">${escapeHtml(exitLabel)}</span>
      <span class="term-trunc" ${truncated ? '' : 'hidden'}>output truncated</span>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Recorded session (full film / full terminal session)
// ---------------------------------------------------------------------------

function renderRecordedSession(input: ProofInput): string {
  const hasFilm = input.sessionFrames.length > 0;
  const hasCli = input.cliSession.length > 0;
  if (!hasFilm && !hasCli) return '';
  const parts: string[] = ['<section class="recorded" id="recorded-session"><h2>Recorded session</h2>'];
  if (hasFilm) {
    parts.push(renderFilmSection('session', input.sessionFrames, 'Full runner-recorded screenshot film'));
  }
  if (hasCli) {
    parts.push(input.cliSession.map((s) => renderTerminal(s)).join('\n'));
  }
  parts.push('</section>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Integrity footer
// ---------------------------------------------------------------------------

const INTEGRITY_ORDER = ['verify-result.json', 'capture/observations.json', 'cli/observations.json', 'run-context.json', 'capture/manifest.json'];

function renderIntegrity(integrity: ProofIntegrity): string {
  const rows = INTEGRITY_ORDER.map((relPath) => {
    const file = integrity.files.find((f) => f.path === relPath);
    if (!file || !file.present) {
      return `<tr class="int-missing"><td>${escapeHtml(relPath)}</td><td colspan="3">not present in this run</td></tr>`;
    }
    return `<tr><td>${escapeHtml(file.path)}</td><td><code>${escapeHtml(file.sha256 ?? '')}</code></td><td>${escapeHtml(String(file.bytes ?? ''))}</td><td>${escapeHtml(file.mtime ?? '')}</td></tr>`;
  }).join('\n');

  return `<footer class="integrity">
  <h2>Integrity</h2>
  <table class="int-table">
    <thead><tr><th>Source file</th><th>sha256</th><th>Bytes</th><th>Modified</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <ul class="int-facts">
    <li>${integrity.screenshotsEmbedded} screenshots embedded (${escapeHtml(formatBytes(integrity.screenshotEncodedBytes))} base64)</li>
    <li>${integrity.screenshotsLinked} screenshots linked past the ${escapeHtml(formatBytes(integrity.screenshotByteCap))} cap</li>
    <li>generator ${escapeHtml(integrity.generatorVersion)} · generated ${escapeHtml(integrity.generatedAt)}</li>
    <li>${escapeHtml(integrity.inputDir)} → ${escapeHtml(integrity.outputPath)}</li>
  </ul>
  <p class="int-regen"><code>${escapeHtml(integrity.regenerateCommand)}</code></p>
</footer>`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

export const PROOF_CSS = `
:root{--bg:#fff;--panel:#f6f8fa;--panel-2:#eef1f4;--border:#d0d7de;--fg:#1f2328;--fg-dim:#636c76;--accent:#0969da;--ok:#1a7f37;--ok-bg:#dafbe1;--err:#cf222e;--err-bg:#ffebe9;--warn:#9a6700;--warn-bg:#fff8c5;--skip:#636c76;--skip-bg:#eef1f4;--term-bg:#0d1117;--term-fg:#c9d1d9;--radius:8px;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--panel-2:#1c2128;--border:#30363d;--fg:#c9d1d9;--fg-dim:#8b949e;--accent:#58a6ff;--ok:#3fb950;--ok-bg:#0f2f1a;--err:#f85149;--err-bg:#3a1417;--warn:#d29922;--warn-bg:#3a2d0f;--skip:#8b949e;--skip-bg:#21262d;}}
*{box-sizing:border-box;}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--fg);line-height:1.5;}
main{max-width:960px;margin:0 auto;padding:0 20px 40px;}
h1,h2,h3,h4{font-weight:600;}
code,pre{font-family:var(--mono);}
a{color:var(--accent);}
.proof-header{padding:24px 20px;border-bottom:1px solid var(--border);background:var(--panel);}
.proof-header h1{margin:0 0 12px;font-size:22px;display:flex;align-items:center;gap:10px;}
.verdict{font-size:13px;padding:2px 10px;border-radius:999px;font-weight:700;letter-spacing:.04em;}
.verdict--pass{background:var(--ok-bg);color:var(--ok);}
.verdict--fail{background:var(--err-bg);color:var(--err);}
.ph-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 24px;margin:0 0 16px;}
.ph-meta div{display:flex;gap:6px;font-size:13px;}
.ph-meta dt{color:var(--fg-dim);margin:0;}
.ph-meta dd{margin:0;}
.chip{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;text-transform:uppercase;background:var(--panel-2);border:1px solid var(--border);}
.progress{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--panel-2);margin-bottom:8px;}
.progress-seg--passed{background:var(--ok);}
.progress-seg--failed{background:var(--err);}
.progress-seg--skipped{background:var(--warn);}
.progress-seg--untested{background:var(--skip);}
.counts{display:flex;gap:16px;font-size:13px;color:var(--fg-dim);margin:0;flex-wrap:wrap;}
.count b{color:var(--fg);}
.area{padding:24px 0;border-bottom:1px solid var(--border);}
.area h2{margin:0 0 8px;}
.area-prose{color:var(--fg-dim);white-space:pre-wrap;}
.behavior{border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin:16px 0;background:var(--panel);}
.behavior--failed{border-color:var(--err);}
.b-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;}
.dot--passed{background:var(--ok);}
.dot--failed{background:var(--err);}
.dot--skipped{background:var(--warn);}
.dot--untested{background:var(--skip);}
.b-id{font-size:12px;color:var(--fg-dim);}
.badge{font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600;}
.badge--passed{background:var(--ok-bg);color:var(--ok);}
.badge--failed{background:var(--err-bg);color:var(--err);}
.badge--skipped{background:var(--warn-bg);color:var(--warn);}
.badge--untested{background:var(--skip-bg);color:var(--skip);}
.badge--verdict{background:var(--panel-2);color:var(--fg-dim);border:1px solid var(--border);}
.badge--repro-confirmed{background:var(--ok-bg);color:var(--ok);}
.badge--repro-unconfirmed{background:var(--warn-bg);color:var(--warn);}
.b-duration{margin-left:auto;font-size:12px;color:var(--fg-dim);}
.b-desc{margin:4px 0;}
.b-details,.b-rationale{color:var(--fg-dim);font-size:14px;}
.b-method .k{color:var(--fg-dim);font-weight:600;margin-right:4px;}
.b-checks{margin:8px 0;}
.monitor-list,.guarantee-list{list-style:none;padding:0;margin:4px 0;font-size:13px;}
.monitor-item,.guarantee-item{padding:4px 0;border-top:1px solid var(--border);}
.b-block{margin-top:12px;border-top:1px solid var(--border);padding-top:8px;}
.b-block summary{cursor:pointer;font-weight:600;font-size:13px;}
.ev-list{list-style:none;padding:0;margin:8px 0;}
.ev{border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:8px;}
.ev-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;}
.ev-type{font-size:11px;text-transform:uppercase;color:var(--fg-dim);}
.ev-label{font-weight:600;font-size:13px;}
.prov{font-size:11px;padding:1px 6px;border-radius:999px;text-decoration:none;}
.prov--runner{background:var(--ok-bg);color:var(--ok);}
.prov--agent{background:var(--panel-2);color:var(--fg-dim);}
.ev-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.ev-col--single{grid-column:1 / -1;}
.ev-col h4{margin:0 0 4px;font-size:11px;color:var(--fg-dim);text-transform:uppercase;}
.ev-col pre{background:var(--panel-2);padding:8px;border-radius:6px;overflow:auto;font-size:12px;margin:0;white-space:pre-wrap;word-break:break-word;}
.ev-shot{display:block;max-width:100%;height:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel-2);}
.ev-shot-caption{font-size:12px;margin:4px 0 0;word-break:break-word;}
.dim{color:var(--fg-dim);}
.exit{display:inline-block;margin-top:4px;font-size:11px;padding:1px 6px;border-radius:4px;}
.exit--ok{background:var(--ok-bg);color:var(--ok);}
.exit--err{background:var(--err-bg);color:var(--err);}
.trace{list-style:none;padding:0;margin:8px 0;}
.trace-step{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-top:1px solid var(--border);font-size:13px;}
.trace-icon{width:16px;text-align:center;color:var(--fg-dim);}
.trace-type{color:var(--fg-dim);width:80px;flex-shrink:0;}
.trace-desc{flex:1;}
.film{margin-top:12px;outline:none;}
.film-stage{background:var(--panel-2);border-radius:6px;display:flex;align-items:center;justify-content:center;min-height:80px;}
.film-img{max-width:100%;display:block;}
.film-caption{font-size:13px;margin:6px 0 0;}
.film-meta{font-size:12px;color:var(--fg-dim);margin:0;}
.film-controls{display:flex;gap:8px;align-items:center;margin-top:6px;}
.film-thumbs{display:flex;gap:6px;overflow-x:auto;list-style:none;padding:6px 0 0;margin:0;}
.film-thumbs img{width:64px;border-radius:4px;border:2px solid transparent;}
.film-thumb.is-current img{border-color:var(--accent);}
.film-note{color:var(--fg-dim);font-size:13px;font-style:italic;}
.term{margin-top:12px;background:var(--term-bg);color:var(--term-fg);border-radius:6px;padding:10px;}
.term-head{display:flex;gap:12px;font-size:12px;color:var(--fg-dim);margin-bottom:6px;flex-wrap:wrap;}
.term-screen{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:0;min-height:20px;}
.term-controls{display:flex;gap:8px;align-items:center;margin-top:8px;}
button{font:inherit;background:var(--panel-2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;cursor:pointer;color:var(--fg);}
button:hover{border-color:var(--accent);}
.recorded{padding:24px 0;border-top:2px solid var(--border);}
.integrity{padding:24px 20px 60px;max-width:960px;margin:0 auto;font-size:12px;color:var(--fg-dim);}
.int-table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px;}
.int-table th,.int-table td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--border);}
.int-missing td{font-style:italic;}
.int-facts{list-style:none;padding:0;}
`;

// ---------------------------------------------------------------------------
// Client-side JS
// ---------------------------------------------------------------------------

export const PROOF_JS = `
(function () {
  'use strict';

  function readProofData() {
    try {
      var el = document.getElementById('proof-data');
      return JSON.parse(el.textContent);
    } catch (e) {
      return { films: {}, frameMs: 1200, lineMs: 30 };
    }
  }

  function buildShotIndex() {
    var map = new Map();
    var imgs = document.querySelectorAll('#shot-store img[data-key]');
    for (var i = 0; i < imgs.length; i++) {
      map.set(imgs[i].getAttribute('data-key'), imgs[i].getAttribute('src'));
    }
    return map;
  }

  function initFilm(section, frames, shots, frameMs) {
    if (!frames || frames.length === 0) return;
    var state = { i: 0, timer: null, playing: false };
    var stage = section.querySelector('.film-img');
    var caption = section.querySelector('.film-caption');
    var meta = section.querySelector('.film-meta');
    var counter = section.querySelector('.film-counter');
    var thumbs = section.querySelectorAll('.film-thumb');
    var playBtn = section.querySelector('.film-play');

    for (var t = 0; t < thumbs.length; t++) {
      var thumbImg = thumbs[t].querySelector('img');
      var key = thumbImg.getAttribute('data-key');
      var src = shots.get(key);
      if (src) thumbImg.src = src;
    }

    // scrollThumb gates the thumbnail-strip scrollIntoView: it must stay
    // false on the very first render (called once per film during page
    // boot) or scrollIntoView bubbles up to the nearest scrollable
    // ancestor — the document itself, since the thumb strip usually isn't
    // scrolled on its own — and yanks the whole page down to whichever
    // film happens to initialize last. Only user-driven navigation (prev/
    // next/thumbnail click/autoplay tick) should move the viewport.
    function render(scrollThumb) {
      var f = frames[state.i];
      var src = shots.get(f.key);
      if (src) stage.src = src;
      stage.alt = 'Frame ' + (state.i + 1) + ' of ' + frames.length;
      caption.textContent = f.caption || '';
      meta.textContent = (f.step !== undefined && f.step !== null ? 'step ' + f.step + ' · ' : '') + (f.url || '');
      counter.textContent = (state.i + 1) + ' / ' + frames.length;
      for (var k = 0; k < thumbs.length; k++) {
        thumbs[k].classList.toggle('is-current', k === state.i);
      }
      if (scrollThumb) {
        var current = thumbs[state.i];
        if (current && current.scrollIntoView) {
          current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }

    function go(delta) {
      state.i = (state.i + delta + frames.length) % frames.length;
      render(true);
    }

    function jump(k) {
      state.i = k;
      render(true);
    }

    function pause() {
      if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      state.playing = false;
      playBtn.textContent = '▶ Play';
      playBtn.setAttribute('aria-pressed', 'false');
    }

    function play() {
      state.playing = true;
      playBtn.textContent = '⏸ Pause';
      playBtn.setAttribute('aria-pressed', 'true');
      state.timer = setInterval(function () {
        go(1);
      }, frameMs);
    }

    function toggle() {
      if (state.playing) pause();
      else play();
    }

    var prevBtn = section.querySelector('.film-prev');
    var nextBtn = section.querySelector('.film-next');
    if (prevBtn) prevBtn.addEventListener('click', function () { pause(); go(-1); });
    if (nextBtn) nextBtn.addEventListener('click', function () { pause(); go(1); });
    if (playBtn) playBtn.addEventListener('click', toggle);
    for (var b = 0; b < thumbs.length; b++) {
      (function (idx) {
        thumbs[idx].addEventListener('click', function () { pause(); jump(idx); });
      })(b);
    }
    section.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); go(1); }
      else if (e.key === ' ') { e.preventDefault(); toggle(); }
    });

    section.__pauseFilm = pause;
    render(false);
  }

  function initTerminal(section, lineMs) {
    var pre = section.querySelector('.term-screen');
    var replayBtn = section.querySelector('.term-replay');
    var skipBtn = section.querySelector('.term-skip');
    var exitBadge = section.querySelector('.exit');
    var full = pre.textContent;
    var lines = full.split('\\n');
    var timer = null;
    var idx = 0;
    var CHUNK = Math.max(1, Math.ceil(lines.length / 400));

    function finish() {
      if (timer) { clearInterval(timer); timer = null; }
      pre.textContent = full;
      skipBtn.hidden = true;
      if (exitBadge) exitBadge.hidden = false;
    }

    function tick() {
      idx += CHUNK;
      pre.textContent = lines.slice(0, idx).join('\\n');
      if (idx >= lines.length) finish();
    }

    function start() {
      pre.textContent = '';
      idx = 0;
      skipBtn.hidden = false;
      if (exitBadge) exitBadge.hidden = true;
      if (timer) clearInterval(timer);
      timer = setInterval(tick, lineMs);
    }

    if (replayBtn) replayBtn.addEventListener('click', start);
    if (skipBtn) skipBtn.addEventListener('click', finish);

    section.__autoplay = function () {
      if (section.dataset.played) return;
      section.dataset.played = '1';
      start();
    };
  }

  function boot() {
    var data = readProofData();
    var shots = buildShotIndex();

    var looseImgs = document.querySelectorAll('img[data-key]');
    for (var s = 0; s < looseImgs.length; s++) {
      try {
        var img = looseImgs[s];
        if (img.closest('#shot-store')) continue;
        var looseSrc = shots.get(img.getAttribute('data-key'));
        if (looseSrc) img.src = looseSrc;
      } catch (e) { /* ignore */ }
    }

    var filmSections = document.querySelectorAll('.film');
    for (var i = 0; i < filmSections.length; i++) {
      try {
        var section = filmSections[i];
        var key = section.getAttribute('data-film');
        var frames = (data.films && data.films[key]) || [];
        initFilm(section, frames, shots, data.frameMs || 1200);
      } catch (e) { /* ignore */ }
    }

    var termSections = document.querySelectorAll('.term');
    for (var j = 0; j < termSections.length; j++) {
      try {
        initTerminal(termSections[j], data.lineMs || 30);
      } catch (e) { /* ignore */ }
    }

    if (typeof IntersectionObserver !== 'undefined' && termSections.length) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && entry.target.__autoplay) {
            entry.target.__autoplay();
          }
        });
      }, { threshold: 0.25 });
      for (var k = 0; k < termSections.length; k++) {
        observer.observe(termSections[k]);
      }
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        var films = document.querySelectorAll('.film');
        for (var f = 0; f < films.length; f++) {
          if (films[f].__pauseFilm) films[f].__pauseFilm();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;
