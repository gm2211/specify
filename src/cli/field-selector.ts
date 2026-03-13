/**
 * Select specific fields from an object using dot/bracket paths.
 * E.g. "summary", "pages[0].requests", "spec.name"
 */
export function selectFields(obj: unknown, paths: string[]): unknown {
  if (paths.length === 1) {
    return getPath(obj, paths[0]);
  }
  const result: Record<string, unknown> = {};
  for (const p of paths) {
    result[p] = getPath(obj, p);
  }
  return result;
}

function getPath(obj: unknown, path: string): unknown {
  const segments = parsePath(path);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof seg === 'number') {
      if (Array.isArray(current)) {
        current = current[seg];
      } else {
        return undefined;
      }
    } else {
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
  }
  return current;
}

function parsePath(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  let current = '';

  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.') {
      if (current) segments.push(current);
      current = '';
    } else if (ch === '[') {
      if (current) segments.push(current);
      current = '';
      const end = path.indexOf(']', i);
      if (end === -1) break;
      const idx = path.slice(i + 1, end);
      const num = parseInt(idx, 10);
      segments.push(isNaN(num) ? idx : num);
      i = end;
    } else {
      current += ch;
    }
  }
  if (current) segments.push(current);
  return segments;
}
