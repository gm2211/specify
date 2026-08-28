/**
 * src/spec/managed-regions.ts — Non-destructive regeneration for generated docs
 *
 * `specify spec context` (and any future doc-generation command) writes into
 * files a human may also hand-edit — PRODUCT.md, DESIGN.md, and similar. Blind
 * overwrite would silently destroy hand edits on every regeneration. This
 * module implements the safety mechanism:
 *
 *   1. Generated content lives inside a pair of HTML-comment markers:
 *        <!-- specify:begin:<region-id> -->
 *        ...generated content...
 *        <!-- specify:end:<region-id> -->
 *      Content OUTSIDE the markers is never touched — a human can add
 *      headings, notes, or whole extra sections above/below the managed
 *      region and they survive every regeneration.
 *
 *   2. Regenerating a file that already has the markers replaces only the
 *      text between them, byte for byte, leaving everything else intact.
 *
 *   3. Regenerating a file that exists but has NO markers (hand-authored
 *      before this feature existed, or edited such that the markers were
 *      removed) is refused in place — instead a `<name>.proposed<ext>`
 *      file is written so the run stays reviewable (diffable, mergeable)
 *      rather than clobbering unmanaged content. `force: true` opts out of
 *      the refusal and overwrites in place.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RegionMarkers {
  begin: string;
  end: string;
}

/** The begin/end HTML-comment markers for a given region id. */
export function regionMarkers(regionId: string): RegionMarkers {
  return {
    begin: `<!-- specify:begin:${regionId} -->`,
    end: `<!-- specify:end:${regionId} -->`,
  };
}

export interface MergeResult {
  content: string;
  hadMarkers: boolean;
}

/**
 * Merge freshly generated `body` into `existing` file content, replacing only
 * the text between the region's begin/end markers. If the markers aren't both
 * present (in order), `existing` is returned unchanged and `hadMarkers` is
 * false — the caller decides what to do (refuse in place, or force).
 */
export function mergeManagedRegion(existing: string, regionId: string, body: string): MergeResult {
  const { begin, end } = regionMarkers(regionId);
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    return { content: existing, hadMarkers: false };
  }
  const before = existing.slice(0, beginIdx);
  const after = existing.slice(endIdx + end.length);
  const content = `${before}${begin}\n${body.trim()}\n${end}${after}`;
  return { content, hadMarkers: true };
}

/** Wrap `body` in fresh region markers, prefixed by `header`. Used when creating a file for the first time, or when force-overwriting an unmanaged one. */
export function wrapFreshManagedRegion(header: string, regionId: string, body: string): string {
  const { begin, end } = regionMarkers(regionId);
  return `${header.trimEnd()}\n\n${begin}\n${body.trim()}\n${end}\n`;
}

export interface WriteManagedFileParams {
  targetPath: string;
  regionId: string;
  /** Prefix written before the markers when the file doesn't exist yet, or when force-overwriting an unmanaged file. Ignored on a managed-region merge. */
  header: string;
  body: string;
  /** Overwrite an unmanaged (marker-less) existing file in place instead of proposing a side file. */
  force?: boolean;
}

export interface WriteManagedFileResult {
  /** True when the target file itself was written (created, merged, or force-overwritten). */
  applied: boolean;
  path: string;
  created: boolean;
  hadMarkers: boolean;
  forced: boolean;
  /** Set only when `applied` is false — the reviewable proposal file that was written instead. */
  proposedPath?: string;
}

/** Derive the `<name>.proposed<ext>` sibling path used for refused overwrites. */
export function proposedPathFor(targetPath: string): string {
  const ext = path.extname(targetPath);
  const base = ext ? targetPath.slice(0, -ext.length) : targetPath;
  return `${base}.proposed${ext || '.md'}`;
}

/**
 * Write (or non-destructively regenerate) a managed-region file.
 *
 *  - File doesn't exist            → create it with fresh markers.
 *  - File exists, has the markers  → replace only the marked region.
 *  - File exists, no markers       → refuse in place; write `<name>.proposed<ext>`
 *                                     instead, unless `force` is set.
 */
export function writeManagedFile(params: WriteManagedFileParams): WriteManagedFileResult {
  const { targetPath, regionId, header, body, force } = params;

  if (!fs.existsSync(targetPath)) {
    const content = wrapFreshManagedRegion(header, regionId, body);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');
    return { applied: true, path: targetPath, created: true, hadMarkers: false, forced: false };
  }

  const existingContent = fs.readFileSync(targetPath, 'utf-8');
  const merged = mergeManagedRegion(existingContent, regionId, body);

  if (merged.hadMarkers) {
    fs.writeFileSync(targetPath, merged.content, 'utf-8');
    return { applied: true, path: targetPath, created: false, hadMarkers: true, forced: false };
  }

  if (force) {
    const content = wrapFreshManagedRegion(header, regionId, body);
    fs.writeFileSync(targetPath, content, 'utf-8');
    return { applied: true, path: targetPath, created: false, hadMarkers: false, forced: true };
  }

  const proposedPath = proposedPathFor(targetPath);
  const content = wrapFreshManagedRegion(header, regionId, body);
  fs.writeFileSync(proposedPath, content, 'utf-8');
  return { applied: false, path: targetPath, created: false, hadMarkers: false, forced: false, proposedPath };
}
