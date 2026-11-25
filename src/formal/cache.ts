import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './process.js';
import type { FormalCheck, FormalOutcome } from './types.js';

/** Bump to discard every cache entry written by an older layout. */
const CACHE_VERSION = 1;
export const CACHE_DIR = path.join('.specify', 'cache', 'gate');

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.lake',
  '.specify',
  '_apalache-out',
  'dist',
  'build',
]);
const MODEL_FILE =
  /(?:\.(?:qnt|lean)|^lakefile\.(?:lean|toml)|^lake-manifest\.json|^lean-toolchain)$/;

function sha256(...parts: Array<string | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

/**
 * Hash of every model file under the root (Quint and Lean sources and the Lean project files).
 * Quint modules import each other and Lean files import the project, so a check's result depends
 * on more than the file it names; hashing them all errs on the side of re-running.
 */
export function hashModelFiles(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && MODEL_FILE.test(entry.name)) {
        const relative = path.relative(root, full).split(path.sep).join('/');
        entries.push(`${relative}\n${sha256(fs.readFileSync(full))}`);
      }
    }
  };
  walk(root);
  return sha256(...entries.sort((a, b) => a.localeCompare(b)));
}

/** The tool's `--version` output, or `undefined` when it cannot be determined (never cached then). */
async function toolVersion(
  executable: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await runProcess(executable, ['--version'], { cwd, timeoutMs });
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return result.exitCode === 0 && !result.unavailable && !result.timedOut && text
    ? text
    : undefined;
}

export interface CheckCacheOptions {
  root: string;
  quintBin: string;
  leanBin: string;
  /** Skip reads and writes entirely. */
  disabled?: boolean;
}

/**
 * Caches passing check outcomes on disk, keyed by the check, the model files and the tool version.
 * Only a check that matched its expectation is stored, so a failure is always re-run.
 */
export class CheckCache {
  readonly #root: string;
  readonly #dir: string;
  readonly #versions = new Map<string, Promise<string | undefined>>();
  readonly #models: string | undefined;
  readonly #bins: Record<FormalCheck['tool'], string>;

  constructor(options: CheckCacheOptions) {
    this.#root = options.root;
    this.#dir = path.join(options.root, CACHE_DIR);
    this.#bins = { quint: options.quintBin, lean: options.leanBin };
    this.#models = options.disabled ? undefined : hashModelFiles(options.root);
  }

  async #key(check: FormalCheck): Promise<string | undefined> {
    if (this.#models === undefined) return undefined;
    const bin = this.#bins[check.tool];
    let version = this.#versions.get(check.tool);
    if (!version) {
      version = toolVersion(bin, this.#root, 30_000).catch(() => undefined);
      this.#versions.set(check.tool, version);
    }
    const resolved = await version;
    if (resolved === undefined) return undefined;
    return sha256(String(CACHE_VERSION), JSON.stringify(check), this.#models, resolved);
  }

  async get(check: FormalCheck): Promise<FormalOutcome | undefined> {
    const key = await this.#key(check);
    if (!key) return undefined;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(this.#dir, `${key}.json`), 'utf8')) as {
        outcome?: FormalOutcome;
      };
      return entry.outcome?.status === check.expect ? entry.outcome : undefined;
    } catch {
      return undefined;
    }
  }

  async set(check: FormalCheck, outcome: FormalOutcome): Promise<void> {
    const key = await this.#key(check);
    if (!key || outcome.status !== check.expect) return;
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      // The directory ignores itself, so projects need no .gitignore entry.
      fs.writeFileSync(path.join(this.#dir, '.gitignore'), '*\n');
      const file = path.join(this.#dir, `${key}.json`);
      fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ outcome }));
      fs.renameSync(`${file}.${process.pid}.tmp`, file);
    } catch {
      // A cache that cannot be written only costs a re-run.
    }
  }
}

/** Map with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
