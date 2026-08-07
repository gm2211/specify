/**
 * src/cli/storage-state.ts — Shared validation for --storage-state
 *
 * Storage-state files hold live session cookies/localStorage. This module
 * only validates that the file exists and parses as JSON — it never logs or
 * returns the file's contents, only the path, so callers can fail fast with
 * a structured error before handing the path to Playwright.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StorageStateError {
  error: 'invalid_storage_state';
  path: string;
  hint: string;
}

/**
 * Validate that `storageStatePath` exists and contains parseable JSON.
 * Returns null when valid, or a structured error object (safe to write to
 * stdout as-is) otherwise. Never reads the file into the error — only the
 * path is surfaced.
 */
export function validateStorageStatePath(storageStatePath: string): StorageStateError | null {
  const resolved = path.resolve(storageStatePath);

  if (!fs.existsSync(resolved)) {
    return { error: 'invalid_storage_state', path: storageStatePath, hint: 'Storage-state file not found' };
  }

  try {
    JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch {
    return { error: 'invalid_storage_state', path: storageStatePath, hint: 'Storage-state file is not valid JSON' };
  }

  return null;
}
