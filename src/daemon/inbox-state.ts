/**
 * src/daemon/inbox-state.ts — File-per-job JSON persistence for inbox messages.
 *
 * Each InboxMessage is written as `<id>.json` under stateDir(). On daemon
 * restart, loadMessages() reads all records back so GET /inbox/:id works even
 * for jobs that were in-flight during a pod rollout.
 *
 * Writes are atomic: the record goes to `<id>.json.tmp` first, then renamed
 * into place, so a mid-write crash never leaves a corrupt file in the dir.
 *
 * The `_registry` subdirectory name cannot collide with message ids (those are
 * `msg_<hex>`), so it is safe to nest it under `.specify/inbox/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InboxMessage } from './inbox.js';

export function stateDir(): string {
  return process.env.SPECIFY_INBOX_STATE_DIR?.trim() ||
    path.resolve('.specify', 'inbox', '_registry');
}

export function saveMessage(msg: InboxMessage): void {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(msg, null, 2);
  const tmp = path.join(dir, `${msg.id}.json.tmp`);
  const dest = path.join(dir, `${msg.id}.json`);
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, dest);
}

export function loadMessages(): InboxMessage[] {
  const dir = stateDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    // Dir missing — normal on first start.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const results: InboxMessage[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.json.tmp')) continue;
    const full = path.join(dir, entry.name);
    try {
      const raw = fs.readFileSync(full, 'utf-8');
      const parsed = JSON.parse(raw) as InboxMessage;
      results.push(parsed);
    } catch {
      // Corrupt file — skip it silently.
    }
  }
  return results;
}

export function pruneMessages(max: number): void {
  const dir = stateDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Collect json files with their sort key (createdAt from content, or mtime).
  const files: Array<{ name: string; sortKey: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.json.tmp')) continue;
    const full = path.join(dir, entry.name);
    let sortKey: string;
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf-8')) as { createdAt?: string };
      sortKey = parsed.createdAt ?? fs.statSync(full).mtime.toISOString();
    } catch {
      try {
        sortKey = fs.statSync(full).mtime.toISOString();
      } catch {
        sortKey = '';
      }
    }
    files.push({ name: entry.name, sortKey });
  }

  if (files.length <= max) return;

  // Sort oldest first, delete the excess.
  files.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
  const toDelete = files.slice(0, files.length - max);
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, f.name));
    } catch {
      // Best effort.
    }
  }
}
