/**
 * src/cli/spec-finder.ts — Auto-discover spec files in the current directory
 *
 * When --spec is not provided, look for spec files in cwd.
 * If exactly one is found, use it. If multiple, list them and ask the user to choose.
 * If none, tell the user to provide --spec.
 */

import * as fs from 'fs';
import * as path from 'path';

const SPEC_PATTERNS = [
  /\.spec\.ya?ml$/i,
  /\.spec\.json$/i,
  /^spec\.ya?ml$/i,
  /^spec\.json$/i,
];

/**
 * Find spec files in a directory.
 * Returns an array of relative paths to matching files.
 */
export function findSpecFiles(dir: string = process.cwd()): string[] {
  try {
    const entries = fs.readdirSync(dir);
    return entries
      .filter(f => SPEC_PATTERNS.some(p => p.test(f)))
      .filter(f => {
        const full = path.join(dir, f);
        return fs.statSync(full).isFile();
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve a spec path: if provided and non-empty, return it as-is.
 * If empty/missing, auto-discover in cwd.
 *
 * Returns { path, autoDiscovered } on success.
 * Returns { error } if no spec can be found or multiple found.
 */
export function resolveSpecPath(provided: string | undefined): {
  path?: string;
  autoDiscovered?: boolean;
  error?: string;
  candidates?: string[];
} {
  if (provided && provided.trim() !== '') {
    return { path: provided, autoDiscovered: false };
  }

  const found = findSpecFiles();

  if (found.length === 0) {
    return {
      error: 'No spec file found in current directory. Provide --spec <path> or create a spec file (e.g. spec.yaml).',
    };
  }

  if (found.length === 1) {
    return { path: found[0], autoDiscovered: true };
  }

  return {
    error: `Multiple spec files found. Provide --spec <path> to choose one.`,
    candidates: found,
  };
}
