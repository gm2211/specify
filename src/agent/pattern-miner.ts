/**
 * src/agent/pattern-miner.ts — Heuristic miner for recurring action sequences.
 *
 * Reads the session-store event corpus, extracts n-gram patterns of
 * consecutive `(role, kind)` tokens, and ranks candidates by frequency
 * across sessions. The output feeds the skill draft synthesizer
 * (src/agent/skill-synthesizer.ts), which turns a high-frequency pattern
 * into a draft SKILL.md.
 *
 * Heuristic rationale: skills are procedural memories — the sequence of
 * actions the agent (or user, in Tier-2 cooperative QA) performs to
 * accomplish a routine task. n-gram frequency is a coarse but effective
 * first cut: a sequence the user has done four times across three sessions
 * is a strong skill candidate; a one-off is not.
 *
 * The miner intentionally does NOT call an LLM. The synthesizer step
 * decides whether a pattern is worth describing in natural language.
 */

import type { EventRow, SessionStore } from './session-store.js';

export interface MineOptions {
  /** Minimum n-gram length to consider. Default 2. */
  minLen?: number;
  /** Maximum n-gram length to consider. Default 4. */
  maxLen?: number;
  /** Drop patterns with fewer occurrences than this. Default 3. */
  minOccurrences?: number;
  /** Drop patterns seen in fewer than this many sessions. Default 2. */
  minSessions?: number;
  /** Cap on returned patterns. Default 20. */
  topK?: number;
  /** When set, restrict mining to this list of session ids. */
  sessionIds?: string[];
  /** Filter events by role before mining. Default: include all. */
  roles?: string[];
  /** Filter events by event-kind prefix. Default: include all. */
  kindPrefixes?: string[];
  /** Skip event kinds matching any of these substrings. Default: ['heartbeat']. */
  excludeKindSubstrings?: string[];
}

export interface PatternExample {
  sessionId: string;
  events: EventRow[];
}

export interface CandidatePattern {
  /** Stable hash-style id derived from the signature. */
  id: string;
  /** Human-readable signature, e.g. "user/click → agent/tool_call → agent/message" */
  signature: string;
  /** Compact list of (role, kind) tuples, in order. */
  tokens: Array<{ role: string; kind: string }>;
  /** Total times this n-gram appeared across all matching sessions. */
  occurrences: number;
  /** Number of distinct sessions this n-gram appeared in. */
  sessionCount: number;
  /** A few illustrative example sequences (capped at 3). */
  examples: PatternExample[];
}

interface InternalAccumulator {
  signature: string;
  tokens: Array<{ role: string; kind: string }>;
  count: number;
  sessions: Set<string>;
  examples: PatternExample[];
}

export function minePatterns(store: SessionStore, opts: MineOptions = {}): CandidatePattern[] {
  const minLen = opts.minLen ?? 2;
  const maxLen = opts.maxLen ?? 4;
  const minOccurrences = opts.minOccurrences ?? 3;
  const minSessions = opts.minSessions ?? 2;
  const topK = opts.topK ?? 20;
  const exclude = opts.excludeKindSubstrings ?? ['heartbeat'];

  const sessions = opts.sessionIds && opts.sessionIds.length
    ? opts.sessionIds.map((id) => ({ sessionId: id }))
    : store.listSessions({ limit: 200 }).map((s) => ({ sessionId: s.sessionId }));

  const accumulators = new Map<string, InternalAccumulator>();

  for (const s of sessions) {
    const events = store.replay(s.sessionId, { limit: 1000 });
    const filtered = filterEvents(events, opts, exclude);
    if (filtered.length < minLen) continue;

    for (let n = minLen; n <= maxLen; n++) {
      for (let i = 0; i + n <= filtered.length; i++) {
        const window = filtered.slice(i, i + n);
        const tokens = window.map((e) => ({ role: e.role, kind: e.kind }));
        const signature = tokens.map((t) => `${t.role}/${t.kind}`).join(' → ');
        const id = `pat_${djb2(signature)}`;
        let acc = accumulators.get(id);
        if (!acc) {
          acc = { signature, tokens, count: 0, sessions: new Set(), examples: [] };
          accumulators.set(id, acc);
        }
        acc.count += 1;
        acc.sessions.add(s.sessionId);
        if (acc.examples.length < 3 && !acc.examples.some((ex) => ex.sessionId === s.sessionId)) {
          acc.examples.push({ sessionId: s.sessionId, events: window });
        }
      }
    }
  }

  const candidates: CandidatePattern[] = [];
  for (const [id, acc] of accumulators) {
    if (acc.count < minOccurrences) continue;
    if (acc.sessions.size < minSessions) continue;
    candidates.push({
      id,
      signature: acc.signature,
      tokens: acc.tokens,
      occurrences: acc.count,
      sessionCount: acc.sessions.size,
      examples: acc.examples,
    });
  }

  // Score: sessionCount weighted heavier than raw occurrence to avoid
  // single-session loops dominating.
  candidates.sort((a, b) => {
    const sa = a.sessionCount * 3 + a.occurrences;
    const sb = b.sessionCount * 3 + b.occurrences;
    return sb - sa;
  });

  return candidates.slice(0, topK);
}

function filterEvents(events: EventRow[], opts: MineOptions, exclude: string[]): EventRow[] {
  return events.filter((e) => {
    if (opts.roles && !opts.roles.includes(e.role)) return false;
    if (opts.kindPrefixes && !opts.kindPrefixes.some((p) => e.kind.startsWith(p))) return false;
    if (exclude.some((sub) => e.kind.includes(sub))) return false;
    return true;
  });
}

/** Tiny stable hash for signature → id. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
