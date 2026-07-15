import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Return the directory that owns a spec source.
 *
 * File specs own state next to the file. Directory specs own state inside the
 * directory itself, so `--spec spec/` stores `.specify/` under `spec/` rather
 * than next to it.
 */
export function specRootDir(specPath: string): string {
  const resolved = path.resolve(specPath);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {
    // Fall back to file semantics for unreadable/nonexistent paths.
  }
  return path.dirname(resolved);
}
