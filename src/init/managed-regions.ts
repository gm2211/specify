/**
 * Managed regions let Specify own a block of a human-edited file (AGENTS.md):
 *
 *   <!-- specify:begin:<region-id> -->
 *   ...generated content...
 *   <!-- specify:end:<region-id> -->
 *
 * Content outside the markers is never touched.
 */

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
