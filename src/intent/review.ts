import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import { loadIntentRecords } from './records.js';
import { assertNoSymlinks } from './workspace.js';

export interface ChangeSnapshot {
  base: string;
  fingerprint: string;
  files: string[];
}

const reviewInputSchema = z
  .object({
    summary: z.string().trim().min(1),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          intentIds: z.array(z.string()),
          outcome: z.enum(['preserved', 'changed', 'unmet', 'none']),
          reason: z.string().trim().min(1),
        })
        .strict(),
    ),
    unmet: z
      .array(z.object({ intentId: z.string().min(1), reason: z.string().trim().min(1) }).strict())
      .optional(),
  })
  .strict();

type ReviewInput = z.infer<typeof reviewInputSchema>;

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolvedRoot(root: string): string {
  const absolute = fs.realpathSync(path.resolve(root));
  if (!fs.statSync(absolute).isDirectory())
    throw new Error(`Repository root is not a directory: ${root}`);
  const top = git(absolute, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  if (fs.realpathSync(top) !== absolute)
    throw new Error(`Root must be the Git repository top level: ${absolute}`);
  return absolute;
}

function resolveBase(root: string, base: string): string {
  if (!base.trim()) throw new Error('Base ref must be provided');
  let sha: string;
  try {
    sha = git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
      .toString('utf8')
      .trim();
  } catch {
    throw new Error(`Base ref does not resolve to a commit: ${base}`);
  }
  try {
    git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  } catch {
    throw new Error(`Base commit must be an ancestor of HEAD: ${sha}`);
  }
  return sha;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function preparePaths(
  root: string,
  packPath: string,
  reviewPath: string,
): { pack: string; review: string } {
  const pack = path.resolve(root, packPath);
  const review = path.resolve(root, reviewPath);
  if (!within(root, pack) || !within(root, review))
    throw new Error('Pack and review paths must be inside repository root');
  if (path.resolve(path.dirname(review)) !== pack || path.basename(review) !== 'review.json') {
    throw new Error('Review path must be exactly <packPath>/review.json');
  }
  assertNoSymlinks(root, pack);
  assertNoSymlinks(root, review);
  if (
    !fs.existsSync(path.join(pack, 'records')) ||
    fs.lstatSync(path.join(pack, 'records')).isSymbolicLink()
  ) {
    throw new Error('Pack path must contain a records directory');
  }
  if (fs.existsSync(review) && fs.lstatSync(review).isSymbolicLink())
    throw new Error('Review path must not be a symlink');
  return { pack, review };
}

function currentFiles(root: string, base: string, excludedPath: string): string[] {
  const names = new Set<string>();
  const changed = git(root, ['diff', '--name-only', '-z', '--no-renames', base, '--']).toString(
    'utf8',
  );
  for (const file of changed.split('\0')) if (file) names.add(file);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString(
    'utf8',
  );
  for (const file of untracked.split('\0')) if (file) names.add(file);
  const excludedRelative = path.relative(root, excludedPath).split(path.sep).join('/');
  names.delete(excludedRelative);
  const unmerged = git(root, ['ls-files', '--unmerged', '-z']).toString('utf8');
  if (unmerged) throw new Error('Cannot review while the index contains unmerged files');
  const staged = git(root, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const unstaged = git(root, ['diff', '--name-only', '-z', '--'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const stagedSet = new Set(staged);
  const partiallyStaged = unstaged.find((file) => stagedSet.has(file) && file !== excludedRelative);
  if (partiallyStaged) throw new Error(`Cannot review partially staged file: ${partiallyStaged}`);
  return [...names].sort();
}

function fingerprintFiles(root: string, base: string, files: string[]): string {
  const hash = createHash('sha256');
  hash.update(`base\0${base}\0`);
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    hash.update(`path\0${relative}\0`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update('deleted\0');
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink())
      hash.update(`mode\0${'120000'}\0symlink\0${fs.readlinkSync(absolute)}\0`);
    else if (stat.isFile()) {
      hash.update(`mode\0${stat.mode & 0o111 ? '100755' : '100644'}\0`);
      hash.update(fs.readFileSync(absolute));
    } else throw new Error(`Unsupported changed path type: ${relative}`);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function getChangeSnapshot(root: string, base: string, reviewPath: string): ChangeSnapshot {
  const repository = resolvedRoot(root);
  const review = path.resolve(repository, reviewPath);
  if (!within(repository, review)) throw new Error('Review path must be inside repository root');
  if (path.basename(review) !== 'review.json')
    throw new Error('Review path must be <packPath>/review.json');
  assertNoSymlinks(repository, review);
  const pack = path.dirname(review);
  if (
    !fs.existsSync(path.join(pack, 'records')) ||
    fs.lstatSync(path.join(pack, 'records')).isSymbolicLink()
  ) {
    throw new Error('Review path must be inside an intent pack with a records directory');
  }
  if (fs.existsSync(review) && fs.lstatSync(review).isSymbolicLink())
    throw new Error('Review path must not be a symlink');
  const resolved = resolveBase(repository, base);
  const files = currentFiles(repository, resolved, review);
  return { base: resolved, fingerprint: fingerprintFiles(repository, resolved, files), files };
}

export interface IntentReviewOptions {
  root: string;
  base: string;
  packPath: string;
  reviewPath: string;
}

export interface IntentReviewCheck extends ChangeSnapshot {
  valid: boolean;
  errors: string[];
  summary?: string;
  filesReviewed?: ReviewInput['files'];
  unmet?: ReviewInput['unmet'];
}

async function validatedInput(
  input: unknown,
  snapshot: ChangeSnapshot,
  packPath: string,
): Promise<ReviewInput> {
  const parsed = reviewInputSchema.parse(input);
  const expected = new Set(snapshot.files);
  const seen = new Set<string>();
  const records = await loadIntentRecords(packPath);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const superseded = new Set(
    records
      .filter((record) => record.kind === 'decision')
      .flatMap((record) => record.supersedes ?? []),
  );
  const activeDecisions = records.filter(
    (record) => record.kind === 'decision' && !superseded.has(record.id),
  );
  const ids = new Set(recordsById.keys());
  const unmetIds = new Set((parsed.unmet ?? []).map((gap) => gap.intentId));
  for (const entry of parsed.files) {
    if (
      path.isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes('..') ||
      entry.path.startsWith('./')
    ) {
      throw new Error(`File path must be repository-relative: ${entry.path}`);
    }
    if (!expected.has(entry.path)) throw new Error(`Unknown changed file in review: ${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`Duplicate file review: ${entry.path}`);
    seen.add(entry.path);
    for (const id of entry.intentIds) {
      if (!ids.has(id)) throw new Error(`Unknown intent ID ${id} for ${entry.path}`);
      if (superseded.has(id)) throw new Error(`Superseded intent ID ${id} cannot be reviewed`);
    }
    if (new Set(entry.intentIds).size !== entry.intentIds.length)
      throw new Error(`Duplicate intent ID for ${entry.path}`);
    if (entry.outcome === 'none' && entry.intentIds.length !== 0)
      throw new Error(`Outcome none must have no intent IDs: ${entry.path}`);
    if (entry.outcome !== 'none' && entry.intentIds.length === 0)
      throw new Error(`Outcome ${entry.outcome} requires intent IDs: ${entry.path}`);
    const applicable = activeDecisions.filter(
      (record) =>
        record.appliesTo.length === 0 ||
        record.appliesTo.some((scope) =>
          scope.endsWith('/') ? entry.path.startsWith(scope) : entry.path === scope,
        ),
    );
    for (const record of applicable) {
      if (!entry.intentIds.includes(record.id) && !unmetIds.has(record.id)) {
        throw new Error(`Applicable decision ${record.id} lacks an outcome for ${entry.path}`);
      }
    }
  }
  for (const file of expected) if (!seen.has(file)) throw new Error(`Missing file review: ${file}`);
  for (const gap of parsed.unmet ?? []) {
    if (!ids.has(gap.intentId)) throw new Error(`Unknown unmet intent ID: ${gap.intentId}`);
    if (superseded.has(gap.intentId))
      throw new Error(`Superseded intent ID ${gap.intentId} cannot be unmet`);
  }
  for (const entry of parsed.files) {
    if (
      entry.outcome === 'unmet' &&
      !(parsed.unmet ?? []).some((gap) => entry.intentIds.includes(gap.intentId))
    ) {
      throw new Error(`Unmet outcome requires matching unmet rationale: ${entry.path}`);
    }
  }
  return parsed;
}

export async function reconcileIntent(
  options: IntentReviewOptions,
  input: unknown,
): Promise<IntentReviewCheck> {
  const root = resolvedRoot(options.root);
  const paths = preparePaths(root, options.packPath, options.reviewPath);
  const snapshot = getChangeSnapshot(root, options.base, paths.review);
  const parsed = await validatedInput(input, snapshot, paths.pack);
  fs.mkdirSync(path.dirname(paths.review), { recursive: true });
  fs.writeFileSync(
    paths.review,
    `${JSON.stringify({ version: 1, base: snapshot.base, fingerprint: snapshot.fingerprint, ...parsed }, null, 2)}\n`,
    { flag: 'w', mode: 0o600 },
  );
  fs.chmodSync(paths.review, 0o600);
  return checkIntentReview({ ...options, root });
}

export async function checkIntentReview(options: IntentReviewOptions): Promise<IntentReviewCheck> {
  const root = resolvedRoot(options.root);
  const paths = preparePaths(root, options.packPath, options.reviewPath);
  const snapshot = getChangeSnapshot(root, options.base, paths.review);
  const errors: string[] = [];
  let summary: string | undefined;
  let filesReviewed: ReviewInput['files'] | undefined;
  let unmet: ReviewInput['unmet'];
  try {
    const stored: unknown = JSON.parse(fs.readFileSync(paths.review, 'utf8'));
    const envelopeSchema = z
      .object({ version: z.literal(1), base: z.string(), fingerprint: z.string() })
      .passthrough();
    const envelope = envelopeSchema.parse(stored);
    if (envelope.base !== snapshot.base) errors.push('Reviewed base does not match current base');
    if (envelope.fingerprint !== snapshot.fingerprint)
      errors.push('Reviewed change snapshot is stale');
    const input = await validatedInput(
      {
        summary: envelope.summary,
        files: envelope.files,
        ...(envelope.unmet === undefined ? {} : { unmet: envelope.unmet }),
      },
      snapshot,
      paths.pack,
    );
    summary = input.summary;
    filesReviewed = input.files;
    unmet = input.unmet;
    if (input.unmet?.length || input.files.some((entry) => entry.outcome === 'unmet'))
      errors.push('Intent review contains unmet requirements');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    ...snapshot,
    valid: errors.length === 0,
    errors,
    ...(summary === undefined ? {} : { summary }),
    ...(filesReviewed === undefined ? {} : { filesReviewed }),
    ...(unmet === undefined ? {} : { unmet }),
  };
}
