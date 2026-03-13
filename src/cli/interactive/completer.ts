/**
 * src/cli/interactive/completer.ts — Tab completion helpers
 *
 * Provides filesystem path completion and command completion
 * for interactive readline interfaces.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Complete a partial filesystem path.
 * Returns [completions, original] suitable for readline's completer callback.
 */
export function completePath(partial: string): [string[], string] {
  if (!partial) {
    // List cwd entries
    return [listDir('.', ''), partial];
  }

  // If the partial is or ends with /, treat it as a directory to list
  if (partial === '/' || partial.endsWith('/') || partial.endsWith(path.sep)) {
    const dir = partial;
    const entries = listDir(dir, dir);
    return [entries, partial];
  }

  // Check if partial itself is a directory (e.g. "." or "src")
  try {
    if (fs.statSync(partial).isDirectory()) {
      const prefix = partial.endsWith('/') ? partial : partial + '/';
      const entries = listDir(partial, prefix);
      // Include the directory itself as a completion (with trailing /)
      return [[prefix, ...entries], partial];
    }
  } catch { /* not a directory, continue to basename matching */ }

  // Complete the basename within the parent dir
  const dir = path.dirname(partial);
  const base = path.basename(partial);

  try {
    const dirToRead = dir === '' ? '.' : dir;
    const entries = fs.readdirSync(dirToRead);
    const matches = entries
      .filter(e => e.startsWith(base))
      .map(e => {
        const full = dir === '.' || dir === '' ? e : path.join(dir, e);
        try {
          if (fs.statSync(full).isDirectory()) return full + '/';
        } catch { /* ignore */ }
        return full;
      });
    return [matches, partial];
  } catch {
    return [[], partial];
  }
}

/**
 * List directory entries, returning full paths with the given prefix.
 * @param dir - The directory to read
 * @param prefix - The prefix to prepend to each entry (e.g. "src/" or "" for cwd)
 */
function listDir(dir: string, prefix: string): string[] {
  try {
    const dirToRead = dir === '' ? '.' : dir;
    return fs.readdirSync(dirToRead).map(e => {
      const full = dir === '.' || dir === '' ? e : path.join(dir, e);
      const display = prefix + e;
      try {
        if (fs.statSync(full).isDirectory()) return display + '/';
      } catch { /* ignore */ }
      return display;
    });
  } catch {
    return [];
  }
}

/**
 * Build a completer function for the REPL that handles both
 * command completion and path completion for path-taking arguments.
 */
export function buildReplCompleter(commands: string[], pathCommands: Set<string>) {
  return function completer(line: string): [string[], string] {
    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);

    // First word: complete commands
    if (parts.length <= 1) {
      const hits = commands.filter(c => c.startsWith(trimmed));
      return [hits.length ? hits : commands, trimmed];
    }

    // Check if the command takes a path argument
    const cmd = parts[0];
    if (pathCommands.has(cmd)) {
      const lastPart = parts[parts.length - 1];
      const [completions, original] = completePath(lastPart);

      // Rebuild full line with each completion
      const prefix = parts.slice(0, -1).join(' ') + ' ';
      const fullCompletions = completions.map(c => prefix + c);
      return [fullCompletions, line];
    }

    // Sub-command completion for known compound commands
    if (cmd === 'load') {
      const subs = ['spec', 'capture'];
      if (parts.length === 2) {
        const hits = subs.filter(s => s.startsWith(parts[1]));
        return [hits.map(h => `${cmd} ${h}`), line];
      }
      // Third arg is a path
      if (parts.length >= 3) {
        const lastPart = parts[parts.length - 1];
        const [completions] = completePath(lastPart);
        const prefix = parts.slice(0, -1).join(' ') + ' ';
        return [completions.map(c => prefix + c), line];
      }
    }

    if (cmd === 'save') {
      const subs = ['spec'];
      if (parts.length === 2) {
        const hits = subs.filter(s => s.startsWith(parts[1]));
        return [hits.map(h => `${cmd} ${h}`), line];
      }
      if (parts.length >= 3) {
        const lastPart = parts[parts.length - 1];
        const [completions] = completePath(lastPart);
        const prefix = parts.slice(0, -1).join(' ') + ' ';
        return [completions.map(c => prefix + c), line];
      }
    }

    if (cmd === 'show') {
      const subs = ['summary', 'failures', 'page'];
      if (parts.length === 2) {
        const hits = subs.filter(s => s.startsWith(parts[1]));
        return [hits.map(h => `${cmd} ${h}`), line];
      }
    }

    if (cmd === 'set') {
      const subs = ['url'];
      if (parts.length === 2) {
        const hits = subs.filter(s => s.startsWith(parts[1]));
        return [hits.map(h => `${cmd} ${h}`), line];
      }
    }

    return [[], line];
  };
}

