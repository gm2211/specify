/**
 * src/agent/honcho-provider.ts — Optional MemoryProvider backed by Honcho
 * (plastic-labs/honcho) for dialectic user modeling across sessions.
 *
 * Honcho is an open-source service that builds a dialectic representation
 * of the user from accumulated conversation. specify uses it as an
 * alternative MemoryProvider — when configured, prompts gain a stable
 * "who you are" preamble that travels across projects and projects-within-
 * the-project.
 *
 * Configuration: set HONCHO_URL (and optional HONCHO_APP / HONCHO_USER) to
 * enable. Without those env vars, defaultMemoryProvider() keeps using the
 * local file-backed provider and Honcho is silently skipped.
 *
 * Wire surface:
 *   const provider = honchoEnabled() ? new HonchoMemoryProvider() : defaultMemoryProvider();
 *
 * The provider is intentionally narrow — it speaks Honcho's HTTP API for
 * the two operations we care about:
 *   - GET dialectic representation → render as prompt preamble
 *   - POST observation → contribute new feedback/lesson
 *
 * Reads from the underlying file-backed store remain available via the
 * `fallback` option so observations stay queryable when Honcho is down.
 */

import type {
  MemoryProvider,
  MemoryScope,
} from './memory-provider.js';
import { FileBackedMemoryProvider } from './memory-provider.js';
import type { DeltaInput, MemoryFile, MemoryRow } from './memory.js';

export interface HonchoConfig {
  /** Base URL of the Honcho service, e.g. http://localhost:8000. */
  url: string;
  /** Honcho "app" id or name; defaults to 'specify'. */
  app?: string;
  /** Honcho "user" id; defaults to current $USER or 'default'. */
  user?: string;
  /** API token if the deployment requires auth. */
  token?: string;
  /** Local fallback provider used for read paths when Honcho is unavailable. */
  fallback?: MemoryProvider;
  /** HTTP fetch implementation override (mostly for tests). */
  fetchImpl?: typeof fetch;
  /** Per-call timeout (ms). Default 4000. */
  timeoutMs?: number;
}

export function honchoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.HONCHO_URL);
}

export function honchoConfigFromEnv(env: Record<string, string | undefined> = process.env): HonchoConfig | null {
  if (!env.HONCHO_URL) return null;
  return {
    url: env.HONCHO_URL,
    app: env.HONCHO_APP ?? 'specify',
    user: env.HONCHO_USER ?? env.USER ?? 'default',
    token: env.HONCHO_TOKEN,
  };
}

export class HonchoMemoryProvider implements MemoryProvider {
  private config: HonchoConfig;
  private fallback: MemoryProvider;
  private fetchImpl: typeof fetch;

  constructor(config: HonchoConfig) {
    this.config = config;
    this.fallback = config.fallback ?? new FileBackedMemoryProvider();
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('HonchoMemoryProvider: fetch implementation required (Node 18+ or polyfill)');
    }
  }

  async read(scope: MemoryScope): Promise<MemoryFile> {
    // Honcho doesn't return our row schema; defer to local fallback for
    // structured rows and treat Honcho as additive prompt context only.
    return this.fallback.read(scope);
  }

  async write(scope: MemoryScope, runId: string, deltas: DeltaInput[]): Promise<MemoryFile> {
    const fileResult = await this.fallback.write(scope, runId, deltas);
    // Best-effort: also push observations/playbooks as Honcho events.
    for (const d of deltas) {
      if (d.contradicts) continue;
      try {
        await this.postEvent({
          type: 'observation',
          content: d.content,
          metadata: {
            specId: scope.specId,
            area_id: d.area_id,
            behavior_id: d.behavior_id,
            kind: d.type,
          },
        });
      } catch {
        // Honcho may be down; the local file already has the row.
      }
    }
    return fileResult;
  }

  async prefetch(scope: MemoryScope, budgetBytes?: number): Promise<string> {
    const local = await this.fallback.prefetch(scope, budgetBytes);
    let dialectic = '';
    try {
      dialectic = await this.fetchDialectic(scope);
    } catch {
      // Best-effort fetch.
    }
    if (!dialectic && !local) return '';
    if (!dialectic) return local;
    if (!local) return dialectic;
    return [dialectic, '', local].join('\n');
  }

  private async fetchDialectic(scope: MemoryScope): Promise<string> {
    const url = `${this.config.url.replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(this.config.app ?? 'specify')}/users/${encodeURIComponent(this.config.user ?? 'default')}/dialectic`;
    const res = await this.timedFetch(url, { method: 'GET' });
    if (!res.ok) return '';
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'representation' in body) {
      const text = (body as { representation: unknown }).representation;
      if (typeof text === 'string' && text.trim()) {
        return ['## Dialectic user model', '', text.trim()].join('\n');
      }
    }
    return '';
  }

  private async postEvent(event: { type: string; content: string; metadata?: Record<string, unknown> }): Promise<void> {
    const url = `${this.config.url.replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(this.config.app ?? 'specify')}/users/${encodeURIComponent(this.config.user ?? 'default')}/events`;
    const res = await this.timedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`Honcho rejected event: ${res.status}`);
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.config.timeoutMs ?? 4000);
    try {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      if (this.config.token) headers['Authorization'] = `Bearer ${this.config.token}`;
      return await this.fetchImpl(url, { ...init, headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Convenience factory: returns a HonchoMemoryProvider when env-configured,
 * otherwise null. Callers fall back to defaultMemoryProvider().
 */
export function honchoFromEnv(env: Record<string, string | undefined> = process.env): HonchoMemoryProvider | null {
  const cfg = honchoConfigFromEnv(env);
  if (!cfg) return null;
  return new HonchoMemoryProvider(cfg);
}
