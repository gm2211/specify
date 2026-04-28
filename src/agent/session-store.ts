/**
 * src/agent/session-store.ts — SQLite + FTS5 session transcript indexer.
 *
 * Every session writes a row in `sessions` and a stream of rows in `events`,
 * with a parallel FTS5 virtual table (`events_fts`) for full-text search.
 *
 * Use `openSessionStore()` to get a SessionStore handle; subscribe to the
 * event bus via `attachToEventBus()` to auto-index live agent events. For
 * cross-session recall during a verify run, call `search(query, opts)`.
 *
 * The store is project-scoped by default (`<spec_dir>/.specify/sessions.db`)
 * so different repos stay isolated. Pass an explicit `dbPath` to share a
 * store across projects (e.g. `~/.specify/sessions.db`).
 */

import Database, { type Database as DB } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eventBus, type SpecifyEvent } from './event-bus.js';

export interface SessionMeta {
  sessionId: string;
  specId?: string;
  targetKey?: string;
  task?: string;
  startedAt: string;
}

export interface EventRow {
  id: number;
  sessionId: string;
  ts: string;
  role: string;
  kind: string;
  content: string;
  tags: string | null;
}

export interface SearchHit {
  sessionId: string;
  specId: string | null;
  targetKey: string | null;
  ts: string;
  role: string;
  kind: string;
  content: string;
  tags: string | null;
  rank: number;
}

export interface SearchOpts {
  /** Cap on rows returned. Default 20. */
  limit?: number;
  /** Restrict to a single specId. */
  specId?: string;
  /** Restrict to a single targetKey. */
  targetKey?: string;
}

export class SessionStore {
  private db: DB;
  private indexAny: ((e: SpecifyEvent) => void) | null = null;

  constructor(db: DB) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        spec_id     TEXT,
        target_key  TEXT,
        task        TEXT,
        started_at  TEXT NOT NULL,
        ended_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        ts          TEXT NOT NULL,
        role        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        content     TEXT NOT NULL,
        tags        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        content,
        tags,
        content_rowid='id',
        content='events',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, content, tags) VALUES (new.id, new.content, COALESCE(new.tags, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, COALESCE(old.tags, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, COALESCE(old.tags, ''));
        INSERT INTO events_fts(rowid, content, tags) VALUES (new.id, new.content, COALESCE(new.tags, ''));
      END;
    `);
  }

  recordSession(meta: SessionMeta): void {
    this.db.prepare(`
      INSERT INTO sessions (session_id, spec_id, target_key, task, started_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        spec_id = COALESCE(excluded.spec_id, sessions.spec_id),
        target_key = COALESCE(excluded.target_key, sessions.target_key),
        task = COALESCE(excluded.task, sessions.task)
    `).run(meta.sessionId, meta.specId ?? null, meta.targetKey ?? null, meta.task ?? null, meta.startedAt);
  }

  endSession(sessionId: string, endedAt: string = new Date().toISOString()): void {
    this.db.prepare(`UPDATE sessions SET ended_at = ? WHERE session_id = ?`)
      .run(endedAt, sessionId);
  }

  recordEvent(input: { sessionId: string; ts?: string; role: string; kind: string; content: string; tags?: string[] }): EventRow {
    const ts = input.ts ?? new Date().toISOString();
    const tags = input.tags && input.tags.length ? input.tags.join(' ') : null;
    const result = this.db.prepare(`
      INSERT INTO events (session_id, ts, role, kind, content, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.sessionId, ts, input.role, input.kind, input.content, tags);
    return {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      ts,
      role: input.role,
      kind: input.kind,
      content: input.content,
      tags,
    };
  }

  /**
   * Run an FTS5 MATCH query against the events corpus. Filters by spec/target
   * are applied server-side via JOIN against sessions.
   */
  search(query: string, opts: SearchOpts = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const conditions: string[] = ['events_fts MATCH ?'];
    const args: unknown[] = [query];
    if (opts.specId) {
      conditions.push('s.spec_id = ?');
      args.push(opts.specId);
    }
    if (opts.targetKey) {
      conditions.push('s.target_key = ?');
      args.push(opts.targetKey);
    }
    args.push(limit);

    const sql = `
      SELECT
        e.session_id   AS sessionId,
        s.spec_id      AS specId,
        s.target_key   AS targetKey,
        e.ts           AS ts,
        e.role         AS role,
        e.kind         AS kind,
        e.content      AS content,
        e.tags         AS tags,
        bm25(events_fts) AS rank
      FROM events_fts
      JOIN events e ON e.id = events_fts.rowid
      JOIN sessions s ON s.session_id = e.session_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...args) as SearchHit[];
  }

  /**
   * Return the chronological event timeline for a single session. Powers
   * Tier-2 replay views and the context-resolver feeding feedback ingest.
   */
  replay(sessionId: string, opts: { limit?: number; before?: string; after?: string } = {}): EventRow[] {
    const limit = opts.limit ?? 500;
    const conditions: string[] = ['session_id = ?'];
    const args: unknown[] = [sessionId];
    if (opts.before) {
      conditions.push('ts <= ?');
      args.push(opts.before);
    }
    if (opts.after) {
      conditions.push('ts >= ?');
      args.push(opts.after);
    }
    args.push(limit);
    const rows = this.db.prepare(`
      SELECT id, session_id AS sessionId, ts, role, kind, content, tags
      FROM events WHERE ${conditions.join(' AND ')}
      ORDER BY id ASC LIMIT ?
    `).all(...args) as EventRow[];
    return rows;
  }

  /**
   * Tail the last N events for a session — most recent first. Used by the
   * feedback ingest path to attach context (URL, last click, last input)
   * to a flagged observation so the agent gets a fully-resolved record.
   */
  recentEvents(sessionId: string, limit = 10): EventRow[] {
    const rows = this.db.prepare(`
      SELECT id, session_id AS sessionId, ts, role, kind, content, tags
      FROM events WHERE session_id = ?
      ORDER BY id DESC LIMIT ?
    `).all(sessionId, limit) as EventRow[];
    return rows.reverse();
  }

  listSessions(opts: { specId?: string; targetKey?: string; limit?: number } = {}): SessionMeta[] {
    const limit = opts.limit ?? 50;
    const conditions: string[] = [];
    const args: unknown[] = [];
    if (opts.specId) {
      conditions.push('spec_id = ?');
      args.push(opts.specId);
    }
    if (opts.targetKey) {
      conditions.push('target_key = ?');
      args.push(opts.targetKey);
    }
    args.push(limit);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = this.db.prepare(`
      SELECT session_id AS sessionId, spec_id AS specId, target_key AS targetKey,
             task, started_at AS startedAt
      FROM sessions ${where}
      ORDER BY started_at DESC LIMIT ?
    `).all(...args) as SessionMeta[];
    return rows;
  }

  /**
   * Subscribe this store to the event bus. Every published event is recorded
   * with a derived (role, kind) tuple. Returns an unsubscribe function.
   */
  attachToEventBus(opts: { sessionId?: string; ensureSession?: SessionMeta; defaults?: Partial<SessionMeta> } = {}): () => void {
    if (opts.ensureSession) this.recordSession(opts.ensureSession);
    const seenSessions = new Set<string>();
    if (opts.ensureSession) seenSessions.add(opts.ensureSession.sessionId);

    const listener = (e: SpecifyEvent): void => {
      const sessionId = e.sessionId ?? opts.sessionId;
      if (!sessionId) return;
      // Lazily ensure a session row exists so FK-tied events don't fail.
      if (!seenSessions.has(sessionId)) {
        this.recordSession({
          sessionId,
          specId: opts.defaults?.specId,
          targetKey: opts.defaults?.targetKey,
          task: opts.defaults?.task,
          startedAt: opts.defaults?.startedAt ?? e.timestamp,
        });
        seenSessions.add(sessionId);
      }
      const role = (e.data?.role as string | undefined) ?? 'system';
      const kind = e.type;
      const content = renderContent(e);
      try {
        this.recordEvent({ sessionId, ts: e.timestamp, role, kind, content });
      } catch {
        // Index errors must not break the agent loop.
      }
    };
    this.indexAny = listener;
    eventBus.on('event', listener);
    return () => {
      if (this.indexAny) eventBus.off('event', this.indexAny);
      this.indexAny = null;
    };
  }

  close(): void {
    this.db.close();
  }
}

function renderContent(e: SpecifyEvent): string {
  // Prefer common content fields, fall back to JSON dump.
  const d = e.data ?? {};
  const c = (d.content ?? d.text ?? d.message) as unknown;
  if (typeof c === 'string' && c.length > 0) return c;
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

/**
 * Resolve the default session-store path for a given spec. Falls back to a
 * user-level path when no spec context is available.
 */
export function defaultSessionDbPath(specPath?: string): string {
  if (specPath) {
    return path.join(path.dirname(path.resolve(specPath)), '.specify', 'sessions.db');
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return path.join(home, '.specify', 'sessions.db');
}

export function openSessionStore(dbPath?: string): SessionStore {
  const resolved = dbPath ?? defaultSessionDbPath();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return new SessionStore(db);
}

/** Generate a fresh session id with the conventional prefix. */
export function newSessionId(): string {
  return `ses_${randomUUID().slice(0, 8)}`;
}
