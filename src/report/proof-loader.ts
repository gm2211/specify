/**
 * src/report/proof-loader.ts — fs + matching layer for `specify prove`
 *
 * Reads a completed verify run (verify-result.json plus the runner-recorded
 * observation traces it may have produced) and assembles the pure ProofInput
 * consumed by src/report/proof-html.ts. This is where the "runner-recorded
 * vs agent-reported" distinction is actually decided: every piece of
 * evidence the agent claimed is checked against the deterministic
 * observation trace the runner itself produced, and only cross-referenced
 * evidence is badged runner-recorded.
 *
 * Best-effort by design: a missing or malformed observations.json must never
 * fail the whole proof — it just means less evidence gets cross-referenced.
 * Only a missing/unparseable verify-result.json is fatal (loadProofInput
 * throws a plain Error, caught by src/cli/commands/prove.ts).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { Spec, VerificationReport, BehaviorResult, Evidence, ActionTraceEntry } from '../spec/types.js';
import type { StepObservation, CliStepObservation } from '../agent/observation.js';
import { SCRIPTED_METHOD } from '../agent/scripted-runner.js';
import type {
  ProofInput,
  ProofArea,
  ProofBehavior,
  ProofEvidenceItem,
  ProofEvidenceActual,
  ProofTraceStep,
  ProofFrame,
  ProofCliStep,
  ProofScreenshot,
  ProofSourceFile,
  ProofIntegrity,
} from './proof-html.js';

export const DEFAULT_SCREENSHOT_BYTE_CAP = 40 * 1024 * 1024; // 40 MiB of base64 bytes
export const MIN_MATCH_CHARS = 12;

export interface LoadProofOptions {
  spec: Spec;
  specPath: string;
  inputDir: string;
  outputPath: string;
  generatorVersion: string;
  maxScreenshotBytes?: number;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Output normalization + matching
// ---------------------------------------------------------------------------

const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;

export function normalizeOutput(text: string): string {
  return text
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter((line) => line.length > 0)
    .join('\n');
}

export function matchCliEvidence(
  ev: Evidence,
  observations: readonly CliStepObservation[],
): { step?: number; reason: string } {
  if (ev.type !== 'command_output') {
    return { reason: `${ev.type} evidence has no deterministic counterpart in this run's recorded observations` };
  }

  // Rule 1 — explicit "step N" citation.
  const haystack = `${ev.label}\n${ev.content}`;
  const stepMatch = /\bstep\s+(\d+)\b/i.exec(haystack);
  if (stepMatch) {
    const n = Number(stepMatch[1]);
    if (n < observations.length) {
      return { step: n, reason: `cites recorded step ${n}` };
    }
  }

  // Rule 2 — normalized output substring match.
  const a = normalizeOutput(ev.content);
  if (a.length > 0) {
    let bestStep: number | undefined;
    for (const obs of observations) {
      const b = normalizeOutput(`${obs.stdout}\n${obs.stderr}`);
      if (b.length === 0) continue;
      if (Math.min(a.length, b.length) < MIN_MATCH_CHARS) continue;
      if (b.includes(a) || a.includes(b)) {
        if (bestStep === undefined || obs.step < bestStep) bestStep = obs.step;
      }
    }
    if (bestStep !== undefined) {
      return { step: bestStep, reason: `output matches recorded step ${bestStep} stdout/stderr` };
    }
  }

  // Rule 3 — argv naming.
  const firstLine = (ev.content.split('\n')[0] ?? '').replace(/^\$\s*/, '');
  for (const obs of observations) {
    const argvStr = obs.argv.join(' ');
    if (argvStr.length === 0) continue;
    if (firstLine === argvStr || (obs.argv.length >= 2 && ev.content.includes(argvStr))) {
      return { step: obs.step, reason: `names recorded step ${obs.step} argv` };
    }
  }

  return { reason: 'no recorded cli_run step matches this text' };
}

export function matchScreenshotEvidence(
  contentOrPath: string,
  available: ReadonlySet<string>,
): { key?: string; reason: string } {
  const name = path.basename(contentOrPath.trim());
  if (available.has(name)) {
    return { key: name, reason: `screenshot ${name} exists in capture/screenshots/` };
  }
  return { reason: `no file named ${name} under capture/screenshots/` };
}

export function buildRegenerateCommand(specPath: string, inputDir: string, outputPath: string): string {
  return `specify prove --spec ${specPath} --input ${inputDir} --output ${outputPath}`;
}

export function readGeneratorVersion(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
        return pkg.version ?? '0.0.0';
      } catch {
        return '0.0.0';
      }
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

function readJsonBestEffort<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Malformed observations.json entries (missing fields, wrong types, or
// non-object junk mixed into the array) must never crash loadProofInput —
// observations.json is best-effort by design (see module notes above). These
// sanitizers run right after the JSON parse and drop non-object entries
// outright, defaulting every field the rest of this module dereferences
// (obs.argv.join(...), path.basename(obs.screenshot), obs.stdout, ...) so a
// truncated or hand-edited trace degrades to "less evidence matched" rather
// than an uncaught exception.

function sanitizeCliObservations(raw: unknown): CliStepObservation[] {
  if (!Array.isArray(raw)) return [];
  const out: CliStepObservation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    out.push({
      step: typeof e.step === 'number' ? e.step : 0,
      argv: Array.isArray(e.argv) ? (e.argv as string[]) : [],
      stdin: typeof e.stdin === 'string' ? e.stdin : undefined,
      stdinTruncated: typeof e.stdinTruncated === 'boolean' ? e.stdinTruncated : undefined,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stdoutTruncated: typeof e.stdoutTruncated === 'boolean' ? e.stdoutTruncated : false,
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      stderrTruncated: typeof e.stderrTruncated === 'boolean' ? e.stderrTruncated : false,
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
      signal: typeof e.signal === 'string' ? e.signal : undefined,
      cwd: typeof e.cwd === 'string' ? e.cwd : '',
      tsStart: typeof e.tsStart === 'number' ? e.tsStart : 0,
      tsEnd: typeof e.tsEnd === 'number' ? e.tsEnd : 0,
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : 0,
      error: typeof e.error === 'string' ? e.error : undefined,
    });
  }
  return out;
}

function sanitizeWebObservations(raw: unknown): StepObservation[] {
  if (!Array.isArray(raw)) return [];
  const out: StepObservation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    out.push({
      step: typeof e.step === 'number' ? e.step : 0,
      action: typeof e.action === 'string' ? e.action : 'unknown',
      args: e.args && typeof e.args === 'object' ? (e.args as Record<string, unknown>) : undefined,
      success: typeof e.success === 'boolean' ? e.success : false,
      error: typeof e.error === 'string' ? e.error : undefined,
      urlBefore: typeof e.urlBefore === 'string' ? e.urlBefore : '',
      urlAfter: typeof e.urlAfter === 'string' ? e.urlAfter : '',
      title: typeof e.title === 'string' ? e.title : undefined,
      tsStart: typeof e.tsStart === 'number' ? e.tsStart : 0,
      tsEnd: typeof e.tsEnd === 'number' ? e.tsEnd : 0,
      ax: (e.ax as StepObservation['ax']) ?? { error: 'missing from observation record' },
      screenshot: typeof e.screenshot === 'string' ? e.screenshot : undefined,
      trafficRange: Array.isArray(e.trafficRange) && e.trafficRange.length === 2 ? (e.trafficRange as [number, number]) : [0, 0],
      consoleRange: Array.isArray(e.consoleRange) && e.consoleRange.length === 2 ? (e.consoleRange as [number, number]) : [0, 0],
      probes: e.probes && typeof e.probes === 'object' ? (e.probes as Record<string, boolean>) : undefined,
      probesTruncated: typeof e.probesTruncated === 'boolean' ? e.probesTruncated : undefined,
    });
  }
  return out;
}

function statFile(relPath: string, inputDir: string): ProofSourceFile {
  const abs = path.join(inputDir, relPath);
  if (!fs.existsSync(abs)) {
    return { path: relPath, present: false };
  }
  try {
    const buf = fs.readFileSync(abs);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const st = fs.statSync(abs);
    return { path: relPath, present: true, sha256, bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { path: relPath, present: false };
  }
}

function toPosixRelativeHref(outputPath: string, targetAbsPath: string): string {
  const rel = path.relative(path.dirname(outputPath), targetAbsPath);
  const posix = rel.split(path.sep).join('/');
  return posix
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

export function loadProofInput(options: LoadProofOptions): ProofInput {
  const { spec, specPath, inputDir, outputPath, generatorVersion } = options;
  const maxScreenshotBytes = options.maxScreenshotBytes ?? DEFAULT_SCREENSHOT_BYTE_CAP;
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();

  // 1. verify-result.json — fatal if unreadable/unparseable.
  const verifyResultPath = path.join(inputDir, 'verify-result.json');
  let verifyResultRaw: unknown;
  try {
    const raw = fs.readFileSync(verifyResultPath, 'utf-8');
    verifyResultRaw = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to read/parse ${verifyResultPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const report = unwrapVerificationReport(verifyResultRaw);

  // 2. observation traces — best-effort. A missing/unparseable file yields
  // [], and a parseable-but-malformed one (non-array, or entries missing
  // fields / not objects) is sanitized rather than trusted verbatim — see
  // sanitizeWebObservations / sanitizeCliObservations above.
  const webObservations = sanitizeWebObservations(
    readJsonBestEffort<unknown>(path.join(inputDir, 'capture', 'observations.json'), []),
  );
  const cliObservations = sanitizeCliObservations(
    readJsonBestEffort<unknown>(path.join(inputDir, 'cli', 'observations.json'), []),
  );

  // 3. available screenshots + shot -> observation index.
  const screenshotsDir = path.join(inputDir, 'capture', 'screenshots');
  const availableShots = new Set<string>();
  if (fs.existsSync(screenshotsDir)) {
    try {
      for (const name of fs.readdirSync(screenshotsDir)) {
        if (/^[a-zA-Z0-9._-]+\.png$/.test(name)) availableShots.add(name);
      }
    } catch {
      // ignore — treated as no screenshots available
    }
  }
  const shotToObservation = new Map<string, StepObservation>();
  for (const obs of webObservations) {
    if (!obs.screenshot) continue;
    const name = path.basename(obs.screenshot);
    if (!shotToObservation.has(name)) shotToObservation.set(name, obs);
  }

  // Evidence matching is data-driven, not keyed off spec.target.type: the
  // CLI command_output rules apply whenever the runner actually recorded
  // any cli_run invocations, and the screenshot rules (screenshot evidence,
  // action_trace screenshot provenance, filmstrip/sessionFrames) apply
  // whenever there's a screenshot to cross-reference against — either an
  // on-disk file or a web observation. Both can be true in the same run
  // (e.g. a cli target whose agent also drove a browser).
  const hasScreenshotEvidence = availableShots.size > 0 || webObservations.length > 0;

  // 4. join spec areas x results by fully-qualified id.
  const resultsById = new Map<string, BehaviorResult>();
  for (const result of report.results ?? []) {
    resultsById.set(result.id, result);
  }
  const matchedIds = new Set<string>();

  const orderedScreenshotKeys: string[] = [];
  const seenKeys = new Set<string>();
  function noteKey(key: string | undefined): void {
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    orderedScreenshotKeys.push(key);
  }

  const areas: ProofArea[] = spec.areas.map((area) => {
    const behaviors: ProofBehavior[] = area.behaviors.map((behavior) => {
      const fqId = `${area.id}/${behavior.id}`;
      const result = resultsById.get(fqId);
      if (result) matchedIds.add(fqId);
      const proofBehavior = buildBehavior(
        fqId,
        behavior.description,
        behavior.details,
        result,
        cliObservations,
        webObservations,
        availableShots,
        shotToObservation,
        hasScreenshotEvidence,
      );
      for (const f of proofBehavior.frames) noteKey(f.key);
      for (const t of proofBehavior.trace) noteKey(t.screenshotKey);
      for (const e of proofBehavior.evidence) noteKey(e.screenshotKey);
      return proofBehavior;
    });
    return { id: area.id, name: area.name, prose: area.prose, behaviors };
  });

  // Results with no matching spec behavior -> synthetic trailing area.
  const unmatched = (report.results ?? []).filter((r) => !matchedIds.has(r.id));
  if (unmatched.length > 0) {
    const behaviors = unmatched.map((result) => {
      const pb = buildBehavior(
        result.id,
        result.description,
        undefined,
        result,
        cliObservations,
        webObservations,
        availableShots,
        shotToObservation,
        hasScreenshotEvidence,
      );
      for (const f of pb.frames) noteKey(f.key);
      for (const t of pb.trace) noteKey(t.screenshotKey);
      for (const e of pb.evidence) noteKey(e.screenshotKey);
      return pb;
    });
    areas.push({ id: 'unmatched-results', name: 'Results without a matching spec behavior', behaviors });
  }

  // Full runner-recorded web film, step order.
  const sessionFrames: ProofFrame[] = webObservations
    .filter((obs) => obs.screenshot && availableShots.has(path.basename(obs.screenshot)))
    .map((obs) => ({
      key: path.basename(obs.screenshot as string),
      caption: `step ${obs.step} · ${obs.action} → ${obs.urlAfter}`,
      source: 'observation' as const,
      observationStep: obs.step,
      url: obs.urlAfter,
    }));
  for (const f of sessionFrames) noteKey(f.key);

  const cliSession: ProofCliStep[] = cliObservations.map((obs) => toProofCliStep(obs));

  // 6. inline vs link, in first-reference order, respecting the byte cap.
  const screenshots: Record<string, ProofScreenshot> = {};
  let cumulativeEncodedBytes = 0;
  let embeddedCount = 0;
  let linkedCount = 0;
  for (const key of orderedScreenshotKeys) {
    const abs = path.join(screenshotsDir, key);
    let buf: Buffer | undefined;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      buf = undefined;
    }
    if (!buf) continue;
    const b64 = buf.toString('base64');
    const encodedBytes = Buffer.byteLength(b64, 'utf-8');
    if (cumulativeEncodedBytes + encodedBytes <= maxScreenshotBytes) {
      screenshots[key] = { kind: 'inline', dataUri: `data:image/png;base64,${b64}`, bytes: buf.length, encodedBytes };
      cumulativeEncodedBytes += encodedBytes;
      embeddedCount++;
    } else {
      screenshots[key] = { kind: 'link', href: toPosixRelativeHref(outputPath, abs), bytes: buf.length };
      linkedCount++;
    }
  }

  // 7. integrity.
  const integrityFiles = [
    'verify-result.json',
    'capture/observations.json',
    'cli/observations.json',
    'run-context.json',
    'capture/manifest.json',
  ].map((rel) => statFile(rel, inputDir));

  const integrity: ProofIntegrity = {
    inputDir,
    outputPath,
    files: integrityFiles,
    screenshotsEmbedded: embeddedCount,
    screenshotsLinked: linkedCount,
    screenshotEncodedBytes: cumulativeEncodedBytes,
    screenshotByteCap: maxScreenshotBytes,
    generatorVersion,
    generatedAt,
    regenerateCommand: buildRegenerateCommand(specPath, inputDir, outputPath),
  };

  // Summary — tallied from the assembled behaviors, not report.summary,
  // since report.summary has no `untested` bucket (spec behaviors with no
  // matching result are untested and only exist post-join).
  const summary = { total: 0, passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const area of areas) {
    for (const b of area.behaviors) {
      summary.total++;
      summary[b.status]++;
    }
  }

  const targetValue: ProofInput['target'] =
    spec.target.type === 'cli' ? { type: 'cli', binary: spec.target.binary } : { type: spec.target.type, url: spec.target.url };

  return {
    generator: { version: generatorVersion, generatedAt, commandLine: buildRegenerateCommand(specPath, inputDir, outputPath) },
    spec: { name: spec.name, version: spec.version, description: spec.description, path: specPath },
    target: targetValue,
    run: { timestamp: report.timestamp, pass: report.pass, summary },
    areas,
    screenshots,
    sessionFrames,
    cliSession,
    integrity,
  };
}

// ---------------------------------------------------------------------------
// Internal: report shape tolerance
// ---------------------------------------------------------------------------

function unwrapVerificationReport(raw: unknown): VerificationReport {
  if (raw && typeof raw === 'object' && 'structuredOutput' in raw) {
    return (raw as { structuredOutput: VerificationReport }).structuredOutput;
  }
  return raw as VerificationReport;
}

// ---------------------------------------------------------------------------
// Internal: per-behavior assembly
// ---------------------------------------------------------------------------

function toProofCliStep(obs: CliStepObservation): ProofCliStep {
  return {
    step: obs.step,
    argv: obs.argv,
    cwd: obs.cwd,
    stdout: obs.stdout,
    stdoutTruncated: obs.stdoutTruncated,
    stderr: obs.stderr,
    stderrTruncated: obs.stderrTruncated,
    exitCode: obs.exitCode,
    signal: obs.signal,
    durationMs: obs.durationMs,
    tsStart: obs.tsStart,
    tsEnd: obs.tsEnd,
    error: obs.error,
  };
}

function buildBehavior(
  fqId: string,
  description: string,
  details: string | undefined,
  result: BehaviorResult | undefined,
  cliObservations: readonly CliStepObservation[],
  webObservations: readonly StepObservation[],
  availableShots: ReadonlySet<string>,
  shotToObservation: ReadonlyMap<string, StepObservation>,
  hasScreenshotEvidence: boolean,
): ProofBehavior {
  if (!result) {
    return {
      id: fqId,
      description,
      details,
      status: 'untested',
      monitor: [],
      guarantees: [],
      evidence: [],
      trace: [],
      frames: [],
      cliSteps: [],
      counts: { runnerRecorded: 0, agentReported: 0 },
    };
  }

  const isScripted = result.method === SCRIPTED_METHOD;
  const evidence: ProofEvidenceItem[] = (result.evidence ?? []).map((ev) =>
    buildEvidenceItem(ev, isScripted, cliObservations, availableShots, hasScreenshotEvidence),
  );

  const matchedCliSteps = new Set<number>();
  for (const ev of evidence) {
    if (ev.actual?.kind === 'cli') matchedCliSteps.add(ev.actual.step);
  }
  const cliSteps: ProofCliStep[] = cliObservations
    .filter((obs) => matchedCliSteps.has(obs.step))
    .sort((a, b) => a.step - b.step)
    .map((obs) => toProofCliStep(obs));

  const trace: ProofTraceStep[] = (result.action_trace ?? []).map((entry) => buildTraceStep(entry, availableShots));

  const { frames, filmstripNote } = deriveFrames(result.action_trace ?? [], webObservations, availableShots, shotToObservation);

  const counts = evidence.reduce(
    (acc, ev) => {
      if (ev.provenance === 'runner-recorded') acc.runnerRecorded++;
      else acc.agentReported++;
      return acc;
    },
    { runnerRecorded: 0, agentReported: 0 },
  );

  return {
    id: fqId,
    description,
    details,
    status: result.status,
    method: result.method,
    rationale: result.rationale,
    durationMs: result.duration_ms,
    verdictSource: result.verdict_source,
    guaranteeSource: result.guarantee_source,
    repro: result.repro,
    monitor: result.monitor ?? [],
    guarantees: result.guarantees ?? [],
    evidence,
    trace,
    frames,
    cliSteps,
    filmstripNote,
    counts,
  };
}

function buildEvidenceItem(
  ev: Evidence,
  isScripted: boolean,
  cliObservations: readonly CliStepObservation[],
  availableShots: ReadonlySet<string>,
  hasScreenshotEvidence: boolean,
): ProofEvidenceItem {
  if (isScripted) {
    return {
      type: ev.type,
      label: ev.label,
      content: ev.content,
      provenance: 'runner-recorded',
      matchReason: 'produced by the scripted replay tier — a Playwright run, no LLM in the loop',
      actual: { kind: 'scripted' },
    };
  }

  // Data-driven, not keyed off spec.target.type: the CLI rules apply
  // whenever this run actually recorded any cli_run invocations, and the
  // screenshot rules apply whenever there's a screenshot to cross-reference
  // (see hasScreenshotEvidence at the call site). Both can fire in the same
  // run for behaviors that mix command_output and screenshot evidence.
  if (ev.type === 'command_output' && cliObservations.length > 0) {
    const { step, reason } = matchCliEvidence(ev, cliObservations);
    if (step !== undefined) {
      const obs = cliObservations.find((o) => o.step === step);
      const actual: ProofEvidenceActual | undefined = obs
        ? { kind: 'cli', step: obs.step, argv: obs.argv, stdout: obs.stdout, stderr: obs.stderr, exitCode: obs.exitCode, signal: obs.signal }
        : undefined;
      return {
        type: ev.type,
        label: ev.label,
        content: ev.content,
        provenance: 'runner-recorded',
        observationStep: step,
        matchReason: reason,
        actual,
      };
    }
    return { type: ev.type, label: ev.label, content: ev.content, provenance: 'agent-reported', matchReason: reason };
  }

  if (ev.type === 'screenshot' && hasScreenshotEvidence) {
    const { key, reason } = matchScreenshotEvidence(ev.content, availableShots);
    if (key) {
      return {
        type: ev.type,
        label: ev.label,
        content: ev.content,
        provenance: 'runner-recorded',
        matchReason: reason,
        screenshotKey: key,
        actual: { kind: 'screenshot', key },
      };
    }
    return { type: ev.type, label: ev.label, content: ev.content, provenance: 'agent-reported', matchReason: reason };
  }

  return {
    type: ev.type,
    label: ev.label,
    content: ev.content,
    provenance: 'agent-reported',
    matchReason: 'agent narration; the runner trace records URLs, AX snapshots, traffic and console ranges but not this text',
  };
}

function buildTraceStep(entry: ActionTraceEntry, availableShots: ReadonlySet<string>): ProofTraceStep {
  const basename = entry.screenshot ? path.basename(entry.screenshot) : undefined;
  const runnerRecorded = !!basename && availableShots.has(basename);
  return {
    type: entry.type,
    description: entry.description,
    timestamp: entry.timestamp,
    screenshotKey: runnerRecorded ? basename : undefined,
    provenance: runnerRecorded ? 'runner-recorded' : 'agent-reported',
  };
}

const FILMSTRIP_NOTE =
  'No per-behavior time window is derivable — BehaviorResult carries only duration_ms and this behavior\'s action_trace has no timestamps. Only screenshots the agent attached to a trace step are shown here; the full runner-recorded film is in "Recorded session" below.';

function deriveFrames(
  trace: ActionTraceEntry[],
  webObservations: readonly StepObservation[],
  availableShots: ReadonlySet<string>,
  shotToObservation: ReadonlyMap<string, StepObservation>,
): { frames: ProofFrame[]; filmstripNote?: string } {
  // 1. Primary: one frame per action_trace entry whose screenshot exists on disk.
  const primary: ProofFrame[] = [];
  for (const entry of trace) {
    if (!entry.screenshot) continue;
    const key = path.basename(entry.screenshot);
    if (!availableShots.has(key)) continue;
    const obs = shotToObservation.get(key);
    primary.push({
      key,
      caption: entry.description,
      source: 'action_trace',
      observationStep: obs?.step,
      timestamp: entry.timestamp,
      url: obs?.urlAfter,
    });
  }
  if (primary.length > 0) return { frames: primary };

  // 2. Fallback: timestamp window over observations.
  const timestamps = trace
    .map((entry) => (entry.timestamp ? Date.parse(entry.timestamp) : NaN))
    .filter((t) => Number.isFinite(t));
  if (timestamps.length > 0) {
    const lo = Math.min(...timestamps) - 2000;
    const hi = Math.max(...timestamps) + 2000;
    const fallback: ProofFrame[] = webObservations
      .filter((obs) => obs.tsStart >= lo && obs.tsEnd <= hi && obs.screenshot && availableShots.has(path.basename(obs.screenshot)))
      .map((obs) => {
        const selector = (obs.args as Record<string, unknown> | undefined)?.selector;
        const selectorSuffix = typeof selector === 'string' ? ` ${selector}` : '';
        return {
          key: path.basename(obs.screenshot as string),
          caption: `${obs.action}${selectorSuffix} → ${obs.urlAfter}`,
          source: 'observation' as const,
          observationStep: obs.step,
          url: obs.urlAfter,
        };
      });
    if (fallback.length > 0) return { frames: fallback };
  }

  // 3. No window derivable.
  return { frames: [], filmstripNote: FILMSTRIP_NOTE };
}
