/**
 * src/spec/design-tokens.ts — Deterministic extraction of visual tokens from code
 *
 * This is the "extracted from code" half of `specify spec context`'s DESIGN.md
 * output, kept strictly separate from the spec-derived "product doctrine" half
 * (src/spec/product-context.ts). It never interprets or invents values — it
 * only reports literal name/value pairs it finds in a small set of
 * conventional token sources:
 *
 *   - `design-tokens.json` / `tokens.json` anywhere under the scanned root
 *     (flat or nested; every leaf string/number becomes one token, named by
 *     its dotted key path)
 *   - CSS custom properties (`--name: value;`) in any `*.css` file
 *
 * If none of these exist, the extraction returns an empty token list — the
 * caller must omit the section rather than fabricate tokens (requirement:
 * no fabrication of visual choices absent from spec or code).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type DesignTokenCategory = 'color' | 'font' | 'spacing' | 'radius' | 'shadow' | 'other';

export interface DesignToken {
  name: string;
  value: string;
  category: DesignTokenCategory;
  /** Path to the source file, relative to the scanned root. */
  source: string;
}

export interface DesignTokenExtraction {
  tokens: DesignToken[];
  /** Relative paths of every source file that contributed at least one token. */
  sources: string[];
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.specify', 'coverage', '.next', '.turbo']);
const TOKENS_FILE_NAMES = new Set(['design-tokens.json', 'tokens.json']);
const MAX_FILES_SCANNED = 2000;
const MAX_DEPTH = 6;
const MAX_TOKENS = 200;

/**
 * Scan `rootDir` for design-token sources. Bounded by depth, file count, and
 * total token count so it stays fast and predictable on large repos.
 */
export function extractDesignTokens(rootDir: string): DesignTokenExtraction {
  const tokens: DesignToken[] = [];
  const sources = new Set<string>();

  const candidates = findCandidateFiles(rootDir);
  for (const file of candidates) {
    if (tokens.length >= MAX_TOKENS) break;
    const base = path.basename(file);
    if (TOKENS_FILE_NAMES.has(base)) {
      collectFromTokensFile(file, rootDir, tokens, sources);
    } else if (file.endsWith('.css')) {
      collectFromCssFile(file, rootDir, tokens, sources);
    }
  }

  return { tokens: tokens.slice(0, MAX_TOKENS), sources: [...sources].sort() };
}

function findCandidateFiles(rootDir: string): string[] {
  const results: string[] = [];
  let scanned = 0;

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || scanned >= MAX_FILES_SCANNED) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES_SCANNED) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        if (TOKENS_FILE_NAMES.has(entry.name) || entry.name.endsWith('.css')) {
          results.push(full);
        }
      }
    }
  }

  walk(rootDir, 0);
  return results;
}

function collectFromTokensFile(file: string, rootDir: string, tokens: DesignToken[], sources: Set<string>): void {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return; // Unparsable — skip, never guess.
  }
  const relSource = path.relative(rootDir, file);
  const before = tokens.length;
  collectJsonLeaves(data, [], relSource, tokens);
  if (tokens.length > before) sources.add(relSource);
}

function collectJsonLeaves(node: unknown, keyPath: string[], source: string, tokens: DesignToken[]): void {
  if (tokens.length >= MAX_TOKENS) return;
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectJsonLeaves(value, [...keyPath, key], source, tokens);
    }
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    const name = keyPath.join('.');
    if (!name) return;
    tokens.push({ name, value: String(node), category: inferCategory(name), source });
  }
}

// Matches a genuine custom-property DECLARATION ("  --name: value;"), not a class
// selector like ".btn--primary:hover". The lookbehind anchors the "--" to the start of
// a declaration (start-of-string, "{", ";", or whitespace) so it never fires mid
// identifier, without consuming the delimiter (so back-to-back declarations with no
// separating whitespace still both match). The value may not contain "{"/"}" so a
// runaway match can never swallow an entire following rule block.
const CSS_CUSTOM_PROP_RE = /(?:^|(?<=[{;\s]))--([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*([^;{}]+);/g;

function collectFromCssFile(file: string, rootDir: string, tokens: DesignToken[], sources: Set<string>): void {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  const relSource = path.relative(rootDir, file);
  const before = tokens.length;
  CSS_CUSTOM_PROP_RE.lastIndex = 0;
  for (let match = CSS_CUSTOM_PROP_RE.exec(content); match !== null && tokens.length < MAX_TOKENS; match = CSS_CUSTOM_PROP_RE.exec(content)) {
    const name = match[1].trim();
    const value = match[2].trim();
    tokens.push({ name, value, category: inferCategory(name), source: relSource });
  }
  if (tokens.length > before) sources.add(relSource);
}

function inferCategory(name: string): DesignTokenCategory {
  const n = name.toLowerCase();
  if (n.includes('color') || n.includes('colour')) return 'color';
  if (n.includes('font') || n.includes('type')) return 'font';
  if (n.includes('space') || n.includes('spacing') || n.includes('gap')) return 'spacing';
  if (n.includes('radius')) return 'radius';
  if (n.includes('shadow')) return 'shadow';
  return 'other';
}
