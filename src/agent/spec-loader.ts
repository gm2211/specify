/**
 * src/agent/spec-loader.ts — Resolve a spec from one of three runtime sources.
 *
 * Used by the QA pod (and any non-CLI deployment) to discover *which* spec
 * to verify against, decoupled from "where on disk does this YAML live".
 *
 * Three sources, mutually exclusive, picked from env:
 *
 *   1. inline — the spec is mounted as a file (typically from a ConfigMap or
 *      a sibling volume). Plain `fs.readFile`.
 *
 *   2. url — the app under test publishes its own spec at e.g.
 *      `/.well-known/specify.spec.yaml`. The QA pod fetches with a bearer
 *      token shared via Terraform. Re-fetched on POST /control/reload-spec.
 *
 *   3. git — clone a repo at a ref, read a path. Decouples spec from app
 *      deploy. Deploy key is read from a file (mounted Secret).
 *
 * `specSourceFromEnv` picks at most one based on which env vars are set;
 * if multiple are set it errors loudly so misconfiguration is caught at
 * pod start, not at first verify.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseSpec } from '../spec/parser.js';
import type { Spec } from '../spec/types.js';

export type SpecSource =
  | { kind: 'inline'; path: string }
  | { kind: 'url'; url: string; bearerFile?: string }
  | { kind: 'git'; repo: string; ref: string; path: string; deployKeyFile?: string };

export interface ResolvedSpec {
  content: string;
  spec: Spec;
  /** sha256 of the canonical spec content; used to tag memory rows. */
  hash: string;
  /** The source the spec was resolved from; useful for inspector UIs. */
  source: SpecSource;
}

export interface ResolveDeps {
  /** Override fetch (testing, custom retries). */
  fetchImpl?: typeof fetch;
  /** Override exec for git clone (testing). */
  execImpl?: typeof runGitClone;
  /** Where to clone temporary git checkouts. Default: os.tmpdir(). */
  tmpRoot?: string;
}

export async function resolveSpec(source: SpecSource, deps: ResolveDeps = {}): Promise<ResolvedSpec> {
  let content: string;
  switch (source.kind) {
    case 'inline':
      content = await readInline(source.path);
      break;
    case 'url':
      content = await fetchUrl(source, deps.fetchImpl ?? globalThis.fetch);
      break;
    case 'git':
      content = await cloneAndRead(source, deps.execImpl ?? runGitClone, deps.tmpRoot ?? os.tmpdir());
      break;
  }
  const spec = parseSpec(content, describeSource(source));
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { content, spec, hash, source };
}

function describeSource(s: SpecSource): string {
  switch (s.kind) {
    case 'inline': return s.path;
    case 'url':    return s.url;
    case 'git':    return `${s.repo}@${s.ref}:${s.path}`;
  }
}

async function readInline(p: string): Promise<string> {
  if (!fs.existsSync(p)) throw new Error(`Spec file not found: ${p}`);
  return fs.readFileSync(p, 'utf-8');
}

async function fetchUrl(src: { url: string; bearerFile?: string }, fetchImpl: typeof fetch): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/yaml, text/yaml, application/json, text/plain' };
  if (src.bearerFile) {
    if (!fs.existsSync(src.bearerFile)) {
      throw new Error(`Spec URL bearer file not found: ${src.bearerFile}`);
    }
    const token = fs.readFileSync(src.bearerFile, 'utf-8').trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetchImpl(src.url, { headers });
  if (!res.ok) {
    throw new Error(`Spec URL fetch failed: ${src.url} → HTTP ${res.status}`);
  }
  return await res.text();
}

export interface GitCloneOpts {
  repo: string;
  ref: string;
  destDir: string;
  deployKeyFile?: string;
}

export type RunGitClone = (opts: GitCloneOpts) => Promise<void>;

export async function runGitClone(opts: GitCloneOpts): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.deployKeyFile) {
    if (!fs.existsSync(opts.deployKeyFile)) {
      throw new Error(`Git deploy key file not found: ${opts.deployKeyFile}`);
    }
    env.GIT_SSH_COMMAND = `ssh -i ${opts.deployKeyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }
  await spawnAwait('git', ['clone', '--depth=1', '--branch', opts.ref, opts.repo, opts.destDir], { env });
}

function spawnAwait(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function cloneAndRead(src: { repo: string; ref: string; path: string; deployKeyFile?: string }, exec: RunGitClone, tmpRoot: string): Promise<string> {
  const dest = fs.mkdtempSync(path.join(tmpRoot, 'specify-spec-'));
  try {
    await exec({ repo: src.repo, ref: src.ref, destDir: dest, deployKeyFile: src.deployKeyFile });
    const target = path.join(dest, src.path);
    if (!fs.existsSync(target)) {
      throw new Error(`Spec path not found in repo ${src.repo}@${src.ref}: ${src.path}`);
    }
    return fs.readFileSync(target, 'utf-8');
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * Pick a SpecSource from environment variables. Returns null when no
 * source is configured (the caller falls back to the CLI --spec flag).
 *
 * Env vars (mutually exclusive groups):
 *
 *   inline:  SPECIFY_SPEC_INLINE_PATH=/path/to/spec.yaml
 *   url:     SPECIFY_SPEC_URL=https://...
 *            SPECIFY_SPEC_URL_BEARER_FILE=/run/secrets/spec-bearer  (optional)
 *   git:     SPECIFY_SPEC_GIT_REPO=git@github.com:org/repo.git
 *            SPECIFY_SPEC_GIT_REF=main
 *            SPECIFY_SPEC_GIT_PATH=specify.spec.yaml
 *            SPECIFY_SPEC_GIT_DEPLOY_KEY_FILE=/run/secrets/deploy-key  (optional)
 */
export function specSourceFromEnv(env: Record<string, string | undefined> = process.env): SpecSource | null {
  const sources: SpecSource[] = [];
  if (env.SPECIFY_SPEC_INLINE_PATH) {
    sources.push({ kind: 'inline', path: env.SPECIFY_SPEC_INLINE_PATH });
  }
  if (env.SPECIFY_SPEC_URL) {
    sources.push({
      kind: 'url',
      url: env.SPECIFY_SPEC_URL,
      bearerFile: env.SPECIFY_SPEC_URL_BEARER_FILE,
    });
  }
  if (env.SPECIFY_SPEC_GIT_REPO) {
    if (!env.SPECIFY_SPEC_GIT_REF || !env.SPECIFY_SPEC_GIT_PATH) {
      throw new Error('SPECIFY_SPEC_GIT_REPO requires SPECIFY_SPEC_GIT_REF and SPECIFY_SPEC_GIT_PATH');
    }
    sources.push({
      kind: 'git',
      repo: env.SPECIFY_SPEC_GIT_REPO,
      ref: env.SPECIFY_SPEC_GIT_REF,
      path: env.SPECIFY_SPEC_GIT_PATH,
      deployKeyFile: env.SPECIFY_SPEC_GIT_DEPLOY_KEY_FILE,
    });
  }
  if (sources.length === 0) return null;
  if (sources.length > 1) {
    const kinds = sources.map((s) => s.kind).join(', ');
    throw new Error(`Multiple spec sources configured (${kinds}); set exactly one of SPECIFY_SPEC_INLINE_PATH / SPECIFY_SPEC_URL / SPECIFY_SPEC_GIT_REPO`);
  }
  return sources[0];
}
