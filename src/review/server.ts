/**
 * src/review/server.ts — Hono HTTP server for the Specify review webapp
 *
 * Serves the built React app from dist/webapp/ and provides API endpoints
 * for reading/writing spec files, verification results, and narratives.
 * WebSocket support for live updates when files change on disk.
 */

import type { Server } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { eventBus } from '../agent/event-bus.js';
import { formulaReviewEnabled, learnedSkillsEnabled } from '../agent/feature-flags.js';
import type { MessageInjector } from '../agent/message-injector.js';
import { specRootDir } from '../spec/paths.js';
import { render } from '../monitor/formula.js';
import { generateWitnesses, type WitnessResult } from '../monitor/witness.js';
import {
  defaultFormulaStatsPath,
  isPromotionCandidate,
  loadFormulaStats,
  type FormulaStatsRow,
} from '../monitor/formula-stats.js';
import {
  defaultFormulasPath,
  loadFormulas,
  saveFormulas,
  setStatus,
  type FormulaEntry,
} from '../spec/formulas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Module-level reference to the active message injector (if any). */
let activeInjector: MessageInjector | null = null;

export function setActiveInjector(injector: MessageInjector | null): void {
  activeInjector = injector;
}

// ---------------------------------------------------------------------------
// Formula review: witness generation is deterministic but not free (a
// bounded search over the formula's atom alphabet), so results are cached
// in-memory keyed by "formula id + content hash" — the id alone is already
// content-derived (see spec/formulas.ts's formulaId), but hashing the AST
// too means a cache hit can never mask a formula whose content changed
// underneath an unchanged id (e.g. a hand-edited formulas.yaml).
// ---------------------------------------------------------------------------
const witnessCache = new Map<string, WitnessResult>();

function witnessCacheKey(entry: FormulaEntry): string {
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(entry.formula)).digest('hex').slice(0, 16);
  return `${entry.id}:${contentHash}`;
}

function witnessesFor(entry: FormulaEntry): WitnessResult {
  const key = witnessCacheKey(entry);
  const cached = witnessCache.get(key);
  if (cached) return cached;
  const result = generateWitnesses(entry.formula);
  witnessCache.set(key, result);
  return result;
}

export type FormulaListEntry = FormulaEntry & {
  behaviorDescription: string | null;
  prettyFormula: string;
  witnesses: WitnessResult;
  /**
   * Run-over-run telemetry (src/monitor/formula-stats.ts), null when the
   * formula has never been evaluated in a merged verify run yet.
   */
  stats: FormulaStatsRow | null;
  /** Draft only: agreement streak with the LLM has crossed the promotion threshold. */
  promotionSuggested: boolean;
  /** Grounding drift flagged: predicates likely stopped resolving against the app. */
  driftFlagged: boolean;
  /** Approved only: disagreed with the LLM's independent verdict — flagged for recompilation. */
  recompileFlagged: boolean;
};

/**
 * Handler bodies for GET/POST /api/formulas*, extracted as plain functions
 * (rather than inlined in the Hono routes below) so they're directly unit
 * testable without spinning up the HTTP server. The routes are thin
 * adapters over these.
 */
export async function listFormulas(resolvedSpec: string): Promise<{ formulas: FormulaListEntry[] }> {
  const { loadSpec } = await import('../spec/parser.js');
  const spec = loadSpec(resolvedSpec);
  const descriptionByBehavior = new Map<string, string>();
  for (const area of spec.areas) {
    for (const behavior of area.behaviors) {
      descriptionByBehavior.set(`${area.id}/${behavior.id}`, behavior.description);
    }
  }

  const file = loadFormulas(defaultFormulasPath(resolvedSpec));
  if (!file) return { formulas: [] };

  const statsFile = loadFormulaStats(defaultFormulaStatsPath(resolvedSpec));

  const formulas = file.formulas.map((entry) => {
    const stats = statsFile.rows[entry.id] ?? null;
    return {
      ...entry,
      behaviorDescription: descriptionByBehavior.get(entry.behavior) ?? null,
      prettyFormula: render(entry.formula),
      witnesses: witnessesFor(entry),
      stats,
      promotionSuggested: entry.status === 'draft' && !!stats && isPromotionCandidate(stats),
      driftFlagged: !!stats?.driftFlagged,
      recompileFlagged: entry.status === 'approved' && !!stats?.recompileFlagged,
    };
  });
  return { formulas };
}

function readRawOrNull(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
}

export function setFormulaStatus(
  resolvedSpec: string,
  id: string,
  status: 'approved' | 'rejected',
  /**
   * Test-only seam: invoked right after the initial load, before the
   * pre-write recheck below, so tests can simulate a concurrent writer
   * landing on disk in that window without monkeypatching fs (whose ESM
   * namespace object isn't reassignable). Never passed in production.
   */
  onLoadedForTest?: () => void,
):
  | { ok: true; id: string; status: 'approved' | 'rejected' }
  | { error: 'not_found' }
  | { error: 'conflict'; message: string } {
  const filePath = defaultFormulasPath(resolvedSpec);
  const rawAtLoad = readRawOrNull(filePath);
  const file = loadFormulas(filePath);
  if (!file || !file.formulas.some((f) => f.id === id)) return { error: 'not_found' };

  onLoadedForTest?.();

  // Guard against a concurrent writer (e.g. a spec-compile run appending a
  // draft via addDraft) clobbering unrelated changes between our load and
  // our write: re-read the raw file immediately before writing and compare
  // it against what we loaded. If it moved, reload fresh content and
  // reapply just this single status mutation onto it instead of writing
  // back the now-stale in-memory copy. This narrows the race window to the
  // gap between the re-read and the write, rather than the whole handler.
  const rawBeforeWrite = readRawOrNull(filePath);
  let base: ReturnType<typeof loadFormulas>;
  if (rawBeforeWrite === rawAtLoad) {
    base = file;
  } else {
    // The concurrent writer may have deleted or corrupted the file; a
    // reload failure here must surface as a handler error response, not
    // an uncaught throw — and must not clobber whatever is on disk.
    try {
      base = loadFormulas(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: 'conflict', message: `Formulas file changed concurrently and could not be reloaded: ${msg}` };
    }
  }
  if (!base || !base.formulas.some((f) => f.id === id)) return { error: 'not_found' };

  const updated = setStatus(base, id, status);
  saveFormulas(filePath, updated);
  eventBus.send(status === 'approved' ? 'formula:approved' : 'formula:rejected', { id });
  return { ok: true, id, status };
}

/** Guard so we don't run two verify agents at once from the server. */
let verifyInFlight = false;

async function runVerifyInBackground(
  specPath: string,
  resultsDir: string,
  scope?: { areaId: string; behaviorId: string },
): Promise<void> {
  if (verifyInFlight) {
    process.stderr.write('Verify already running — ignoring new request.\n');
    return;
  }
  verifyInFlight = true;
  try {
    eventBus.send('verify:started', { scope: scope ?? null });
    const { loadSpec, specToYaml } = await import('../spec/parser.js');
    const { runSpecifyAgent } = await import('../agent/sdk-runner.js');
    const { getVerifyPrompt } = await import('../agent/prompts.js');

    const spec = loadSpec(specPath);

    // Scope: narrow the spec to a single behavior if requested.
    const scopedSpec = scope
      ? (() => {
          const area = spec.areas.find((a) => a.id === scope.areaId);
          const behavior = area?.behaviors.find((b) => b.id === scope.behaviorId);
          if (!area || !behavior) {
            throw new Error(`Behavior ${scope.areaId}/${scope.behaviorId} not found in spec`);
          }
          return { ...spec, areas: [{ ...area, behaviors: [behavior] }] };
        })()
      : spec;

    const { loadExplorationHints } = await import('../model/runner-hooks.js');
    const explorationHints = loadExplorationHints({
      specPath,
      specId: spec.name,
      target: {
        type: spec.target.type,
        url: (spec.target as { url?: string }).url,
        binary: (spec.target as { binary?: string }).binary,
      },
    });
    const prompt = getVerifyPrompt(specToYaml(scopedSpec), undefined, explorationHints);
    const targetUrl =
      spec.target.type === 'web' || spec.target.type === 'api'
        ? (spec.target as { url: string }).url
        : undefined;

    const { structuredOutput } = await runSpecifyAgent({
      task: 'verify',
      systemPrompt: prompt,
      userPrompt: scope
        ? `Verify only behavior "${scope.areaId}/${scope.behaviorId}" against the spec.`
        : `Verify the target against the behavioral spec.`,
      ...(targetUrl ? { url: targetUrl } : {}),
      spec: specPath,
      outputDir: resultsDir,
    });

    // Merge: scoped runs update just the targeted behavior in the existing report.
    const reportPath = path.join(resultsDir, 'verify-result.json');
    const existing = fs.existsSync(reportPath)
      ? (() => {
          try {
            const raw = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
            return raw && typeof raw === 'object' && 'structuredOutput' in raw
              ? (raw as { structuredOutput: unknown }).structuredOutput
              : raw;
          } catch {
            return null;
          }
        })()
      : null;

    const merged =
      scope && existing && typeof existing === 'object' && 'results' in existing
        ? mergeScopedResult(existing as Record<string, unknown>, structuredOutput, scope)
        : structuredOutput;

    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ structuredOutput: merged }, null, 2), 'utf-8');
    eventBus.send('verify:completed', { scope: scope ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Strip ANSI escape sequences that Playwright (and others) emit in error
    // messages — they look like garbage in HTML.
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    eventBus.send('verify:failed', { scope: scope ?? null, error: clean });
    throw err;
  } finally {
    verifyInFlight = false;
  }
}

/**
 * Merge a scoped (single-behavior) verify result into an existing full report.
 * Replaces the matching result and recomputes the summary.
 */
function mergeScopedResult(
  existing: Record<string, unknown>,
  fresh: unknown,
  scope: { areaId: string; behaviorId: string },
): Record<string, unknown> {
  const freshResults = Array.isArray((fresh as { results?: unknown })?.results)
    ? ((fresh as { results: Array<Record<string, unknown>> }).results)
    : [];
  const targetId = `${scope.areaId}/${scope.behaviorId}`;
  const incoming = freshResults.find((r) => r.id === targetId);
  if (!incoming) return existing;

  const prevResults = Array.isArray(existing.results)
    ? (existing.results as Array<Record<string, unknown>>)
    : [];
  const nextResults = prevResults.some((r) => r.id === targetId)
    ? prevResults.map((r) => (r.id === targetId ? incoming : r))
    : [...prevResults, incoming];

  const passed = nextResults.filter((r) => r.status === 'passed').length;
  const failed = nextResults.filter((r) => r.status === 'failed').length;
  const skipped = nextResults.filter((r) => r.status === 'skipped').length;

  return {
    ...existing,
    results: nextResults,
    summary: { total: nextResults.length, passed, failed, skipped },
    pass: failed === 0 && nextResults.length > 0,
  };
}

export interface ServeOptions {
  specPath: string;
  port: number;
  open: boolean;
  agentReport?: string;
}

export async function startReviewServer(options: ServeOptions): Promise<void> {
  const { specPath, port, open: shouldOpen, agentReport } = options;
  const resolvedSpec = path.resolve(specPath);
  const specDir = specRootDir(resolvedSpec);
  const resultsPath = path.join(specDir, '.specify', 'verify', 'verify-result.json');
  const resultsDir = path.join(specDir, '.specify', 'verify');

  // Dynamic imports for heavy deps
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { WebSocketServer } = await import('ws');

  // Resolve webapp dist directory — walk up from this file to project root
  let projectRoot = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(projectRoot, 'package.json'))) break;
    projectRoot = path.dirname(projectRoot);
  }
  const webappDist = path.join(projectRoot, 'dist', 'webapp');

  const app = new Hono();

  // -------------------------------------------------------------------------
  // API endpoints
  // -------------------------------------------------------------------------

  app.get('/api/spec', async (c) => {
    try {
      const { loadSpec } = await import('../spec/parser.js');
      const spec = loadSpec(resolvedSpec);
      return c.json(spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'load_failed', message: msg }, 500);
    }
  });

  app.get('/api/results', async (c) => {
    // If an agent report was provided via CLI, prefer that
    const reportPath = agentReport ? path.resolve(agentReport) : resultsPath;
    try {
      if (!fs.existsSync(reportPath)) {
        return c.json({});
      }
      const raw = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      // CLI writes { structuredOutput: {...} }; unwrap for the webapp.
      const data = raw && typeof raw === 'object' && 'structuredOutput' in raw
        ? (raw as { structuredOutput: unknown }).structuredOutput
        : raw;
      return c.json(data ?? {});
    } catch {
      return c.json({});
    }
  });

  // Serve screenshot files captured during verify runs. The agent stores
  // absolute paths in action_trace; the client passes the basename and we
  // look it up under the known screenshots directory.
  const screenshotsDir = path.join(resultsDir, 'capture', 'screenshots');
  app.get('/api/screenshot/:name', async (c) => {
    const name = c.req.param('name');
    // Security: only allow plain filenames, no traversal.
    if (!/^[a-zA-Z0-9._-]+\.png$/.test(name)) {
      return c.text('Bad request', 400);
    }
    const filePath = path.join(screenshotsDir, name);
    if (!filePath.startsWith(screenshotsDir) || !fs.existsSync(filePath)) {
      return c.text('Not found', 404);
    }
    const content = fs.readFileSync(filePath);
    return new Response(content, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
    });
  });

  app.get('/api/narrative', async (c) => {
    try {
      const { loadSpec } = await import('../spec/parser.js');
      const spec = loadSpec(resolvedSpec);
      const isDirectorySpec = fs.existsSync(resolvedSpec) && fs.statSync(resolvedSpec).isDirectory();
      const baseName = isDirectorySpec
        ? 'spec.narrative.md'
        : path.basename(resolvedSpec).replace(/\.(ya?ml|json)$/, '.narrative.md');
      const narrativePath = path.resolve(specDir, spec.narrative_path ?? baseName);
      if (!fs.existsSync(narrativePath)) {
        return c.json({ content: '' });
      }
      const content = fs.readFileSync(narrativePath, 'utf-8');
      return c.json({ content });
    } catch {
      return c.json({ content: '' });
    }
  });

  app.put('/api/spec', async (c) => {
    try {
      const body = await c.req.json<{ yaml: string }>();
      if (!body.yaml || typeof body.yaml !== 'string') {
        return c.json({ error: 'invalid_body', message: 'Expected { yaml: string }' }, 400);
      }
      // Validate before writing
      const { parseSpec } = await import('../spec/parser.js');
      parseSpec(body.yaml, resolvedSpec);
      if (fs.existsSync(resolvedSpec) && fs.statSync(resolvedSpec).isDirectory()) {
        return c.json({
          error: 'unsupported_write',
          message: 'Directory specs cannot be overwritten with a flattened YAML document.',
        }, 409);
      }
      // Write to disk
      fs.writeFileSync(resolvedSpec, body.yaml, 'utf-8');
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'write_failed', message: msg }, 400);
    }
  });

  app.get('/api/verify/status', async (c) => {
    return c.json({ inFlight: verifyInFlight });
  });

  app.post('/api/verify', async (c) => {
    if (verifyInFlight) return c.json({ error: 'busy' }, 409);
    runVerifyInBackground(resolvedSpec, resultsDir).catch((err) => {
      process.stderr.write(`Verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return c.json({ started: true });
  });

  app.post('/api/verify/:areaId/:behaviorId', async (c) => {
    if (verifyInFlight) return c.json({ error: 'busy' }, 409);
    const { areaId, behaviorId } = c.req.param();
    runVerifyInBackground(resolvedSpec, resultsDir, { areaId, behaviorId }).catch((err) => {
      process.stderr.write(`Scoped verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return c.json({ started: true, areaId, behaviorId });
  });

  // -------------------------------------------------------------------------
  // Event stream (SSE) — inter-agent event channel
  // -------------------------------------------------------------------------

  app.get('/api/events/stream', async (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        // Send recent events for catch-up
        for (const event of eventBus.recent(20)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        // Subscribe to new events
        const unsub = eventBus.onAny((event) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            unsub();
          }
        });
        // Clean up on close (handled by AbortSignal)
        c.req.raw.signal.addEventListener('abort', () => unsub());
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  });

  // Publish an event from an external agent
  app.post('/api/events/publish', async (c) => {
    try {
      const body = await c.req.json<{ type: string; data?: Record<string, unknown> }>();
      if (!body.type) return c.json({ error: 'missing type' }, 400);
      eventBus.send(body.type, body.data ?? {});
      return c.json({ published: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Skill drafts: list / approve / reject. This experimental surface is hidden
  // unless SPECIFY_ENABLE_LEARNED_SKILLS=true.
  app.get('/api/skill-drafts', async (c) => {
    if (!learnedSkillsEnabled()) return c.json({ drafts: [] });
    try {
      const { listDrafts } = await import('../agent/skill-synthesizer.js');
      const drafts = listDrafts(resolvedSpec);
      return c.json({ drafts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'list_failed', message: msg }, 500);
    }
  });

  app.post('/api/skill-drafts/:id/approve', async (c) => {
    if (!learnedSkillsEnabled()) return c.json({ error: 'learned_skills_disabled' }, 404);
    try {
      const { listDrafts, promoteDraft } = await import('../agent/skill-synthesizer.js');
      const id = c.req.param('id');
      const draft = listDrafts(resolvedSpec).find((d) => d.id === id);
      if (!draft) return c.json({ error: 'not_found' }, 404);
      const result = promoteDraft(draft.filePath, { specPath: resolvedSpec });
      eventBus.send('skill:approved', { id, skillName: result.skillName, skillPath: result.skillPath });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'approve_failed', message: msg }, 500);
    }
  });

  app.post('/api/skill-drafts/:id/reject', async (c) => {
    if (!learnedSkillsEnabled()) return c.json({ error: 'learned_skills_disabled' }, 404);
    try {
      const { listDrafts, setDraftStatus } = await import('../agent/skill-synthesizer.js');
      const id = c.req.param('id');
      const draft = listDrafts(resolvedSpec).find((d) => d.id === id);
      if (!draft) return c.json({ error: 'not_found' }, 404);
      setDraftStatus(draft.filePath, 'rejected');
      eventBus.send('skill:rejected', { id });
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'reject_failed', message: msg }, 500);
    }
  });

  app.get('/api/skills/active', async (c) => {
    if (!learnedSkillsEnabled()) return c.json({ skills: [] });
    try {
      const { listActiveSkills } = await import('../agent/skill-synthesizer.js');
      return c.json({ skills: listActiveSkills(resolvedSpec) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'list_failed', message: msg }, 500);
    }
  });

  // Formula review: list / approve / reject compiled LTLf formulas
  // (src/spec/formulas.ts) with witness examples attached, so review turns
  // into "read these example runs" rather than "read this logic AST"
  // (see src/monitor/witness.ts). Hidden unless SPECIFY_ENABLE_FORMULA_REVIEW=true.
  app.get('/api/formulas', async (c) => {
    if (!formulaReviewEnabled()) return c.json({ formulas: [] });
    try {
      return c.json(await listFormulas(resolvedSpec));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'list_failed', message: msg }, 500);
    }
  });

  app.post('/api/formulas/:id/approve', async (c) => {
    if (!formulaReviewEnabled()) return c.json({ error: 'formula_review_disabled' }, 404);
    try {
      const result = setFormulaStatus(resolvedSpec, c.req.param('id'), 'approved');
      if ('error' in result) return c.json(result, result.error === 'conflict' ? 409 : 404);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'approve_failed', message: msg }, 500);
    }
  });

  app.post('/api/formulas/:id/reject', async (c) => {
    if (!formulaReviewEnabled()) return c.json({ error: 'formula_review_disabled' }, 404);
    try {
      const result = setFormulaStatus(resolvedSpec, c.req.param('id'), 'rejected');
      if ('error' in result) return c.json(result, result.error === 'conflict' ? 409 : 404);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'reject_failed', message: msg }, 500);
    }
  });

  // Session replay: chronological event log for a single session, powering
  // Tier-2 replay views and downstream analysis (pattern miner, etc.).
  app.get('/api/sessions/:id/replay', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const limitParam = c.req.query('limit');
      const limit = limitParam ? Math.max(1, Math.min(2000, Number(limitParam))) : 500;
      const { defaultSessionDbPath, openSessionStore } = await import('../agent/session-store.js');
      const store = openSessionStore(defaultSessionDbPath(resolvedSpec));
      try {
        const events = store.replay(sessionId, { limit });
        return c.json({ sessionId, events });
      } finally {
        store.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'replay_failed', message: msg }, 500);
    }
  });

  // Cooperative-QA feedback: webapp sends per-event flags + free-text notes;
  // we route by kind into an Observation (per-spec layer) and optionally a
  // bd issue. See src/agent/feedback.ts for kind semantics.
  app.post('/api/feedback', async (c) => {
    try {
      const body = await c.req.json<{
        kind: string;
        text: string;
        sessionId?: string;
        areaId?: string;
        behaviorId?: string;
        eventId?: string;
      }>();
      if (!body.kind || !body.text) {
        return c.json({ error: 'invalid_body', message: 'Expected { kind, text, ... }' }, 400);
      }
      const allowed = new Set(['note', 'important_pattern', 'missed_check', 'false_positive', 'ignore_pattern', 'file_bug']);
      if (!allowed.has(body.kind)) {
        return c.json({ error: 'invalid_kind', message: `kind must be one of: ${Array.from(allowed).join(', ')}` }, 400);
      }
      const { ingestFeedback } = await import('../agent/feedback.js');
      const result = await ingestFeedback(
        {
          kind: body.kind as 'note',
          text: body.text,
          sessionId: body.sessionId,
          areaId: body.areaId,
          behaviorId: body.behaviorId,
          eventId: body.eventId,
        },
        { specPath: resolvedSpec },
      );
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'feedback_failed', message: msg }, 400);
    }
  });

  // Inject a message into the running agent session
  app.post('/api/agent/inject', async (c) => {
    if (!activeInjector) {
      return c.json({ error: 'no_active_session' }, 404);
    }
    try {
      const body = await c.req.json<{ message: string; priority?: 'now' | 'next' | 'later' }>();
      if (!body.message) return c.json({ error: 'missing message' }, 400);
      activeInjector.inject(body.message, body.priority ?? 'next');
      return c.json({ injected: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // -------------------------------------------------------------------------
  // Static file serving (built React app)
  // -------------------------------------------------------------------------

  app.get('/*', async (c) => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const filePath = path.join(webappDist, reqPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(webappDist)) {
      return c.text('Forbidden', 403);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      };
      const contentType = mimeTypes[ext] ?? 'application/octet-stream';
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      });
    }

    // SPA fallback — serve index.html for unmatched routes
    const indexPath = path.join(webappDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      return c.html(content);
    }

    return c.text('Not found', 404);
  });

  // -------------------------------------------------------------------------
  // Start HTTP server
  // -------------------------------------------------------------------------

  const server = serve({
    fetch: app.fetch,
    port,
  });

  // -------------------------------------------------------------------------
  // WebSocket server for live updates
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ server: server as Server });

  function broadcast(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(data);
      }
    }
  }

  // Forward agent events over WebSocket
  const unsubEvents = eventBus.onAny((event) => {
    broadcast({ type: 'agent:event', event });
  });

  // -------------------------------------------------------------------------
  // File watching
  // -------------------------------------------------------------------------

  const watchers: fs.FSWatcher[] = [];

  // Watch spec file
  try {
    const specWatcher = fs.watch(resolvedSpec, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        broadcast({ type: 'spec:updated' });
      }
    });
    watchers.push(specWatcher);
  } catch {
    process.stderr.write(`Warning: could not watch spec file: ${resolvedSpec}\n`);
  }

  // Watch results directory
  if (fs.existsSync(resultsDir)) {
    try {
      const resultsWatcher = fs.watch(resultsDir, { persistent: false }, (eventType, filename) => {
        if (filename && filename.endsWith('.json')) {
          broadcast({ type: 'results:updated' });
        }
      });
      watchers.push(resultsWatcher);
    } catch {
      process.stderr.write(`Warning: could not watch results directory: ${resultsDir}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Startup info
  // -------------------------------------------------------------------------

  const url = `http://localhost:${port}`;
  process.stderr.write(`\n  Specify Review Server\n`);
  process.stderr.write(`  Spec:    ${resolvedSpec}\n`);
  process.stderr.write(`  Server:  ${url}\n`);
  if (agentReport) {
    process.stderr.write(`  Report:  ${path.resolve(agentReport)}\n`);
  }
  process.stderr.write(`\n  Press Ctrl+C to stop.\n\n`);

  // Auto-open in browser
  if (shouldOpen) {
    const { execFile } = await import('child_process');
    const platform = process.platform;
    const openCmd = platform === 'darwin' ? 'open'
      : platform === 'win32' ? 'cmd'
      : 'xdg-open';
    const openArgs = platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url];
    execFile(openCmd, openArgs, (err) => {
      if (err) {
        process.stderr.write(`Could not auto-open browser: ${err.message}\n`);
        process.stderr.write(`Open manually: ${url}\n`);
      }
    });
  }

  // Keep the process alive — wait for SIGINT/SIGTERM
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      unsubEvents();
      for (const w of watchers) w.close();
      wss.close();
      resolve();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}
