/**
 * src/spec/generator.ts — Generate a draft spec from capture output
 *
 * Reads a capture directory (traffic.json + optional console.json)
 * and produces a draft behavioral spec (v2) that a human can refine.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  Spec,
  Area,
  Behavior,
} from './types.js';
import type { CapturedTraffic, CapturedConsoleEntry } from '../capture/types.js';
import { specToYaml } from './parser.js';

// ---------------------------------------------------------------------------
// Capture loading
// ---------------------------------------------------------------------------

function loadTraffic(dir: string): CapturedTraffic[] {
  const trafficPath = path.join(dir, 'traffic.json');
  if (!fs.existsSync(trafficPath)) {
    console.error(`traffic.json not found in ${dir}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(trafficPath, 'utf-8');
  return JSON.parse(raw) as CapturedTraffic[];
}

function loadConsole(dir: string): CapturedConsoleEntry[] {
  const consolePath = path.join(dir, 'console.json');
  if (!fs.existsSync(consolePath)) {
    return [];
  }
  const raw = fs.readFileSync(consolePath, 'utf-8');
  return JSON.parse(raw) as CapturedConsoleEntry[];
}

// ---------------------------------------------------------------------------
// URL / path utilities
// ---------------------------------------------------------------------------

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function extractOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Convert a URL path to a slug suitable for an area/behavior ID. */
function pathToId(urlPath: string): string {
  return urlPath
    .replace(/^\//, '')
    .replace(/[\/\?&#=.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    || 'root';
}

// ---------------------------------------------------------------------------
// Grouping traffic by page
// ---------------------------------------------------------------------------

interface PageGroup {
  pagePath: string;
  requests: CapturedTraffic[];
}

function groupByPage(traffic: CapturedTraffic[]): PageGroup[] {
  const pathToRequests = new Map<string, CapturedTraffic[]>();

  for (const entry of traffic) {
    const urlPath = extractPath(entry.url);
    const segments = urlPath.split('/').filter(Boolean);

    let pagePath: string;
    if (segments[0] === 'api' && segments.length >= 2) {
      pagePath = '/' + segments[1];
    } else if (segments.length > 0) {
      pagePath = '/' + segments[0];
    } else {
      pagePath = '/';
    }

    const existing = pathToRequests.get(pagePath);
    if (existing) {
      existing.push(entry);
    } else {
      pathToRequests.set(pagePath, [entry]);
    }
  }

  return Array.from(pathToRequests.entries())
    .map(([pagePath, requests]) => ({ pagePath, requests }))
    .sort((a, b) => a.pagePath.localeCompare(b.pagePath));
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

function deduplicateRequests(requests: CapturedTraffic[]): CapturedTraffic[] {
  const seen = new Map<string, CapturedTraffic>();
  for (const req of requests) {
    const key = `${req.method} ${extractPath(req.url)}`;
    if (!seen.has(key)) {
      seen.set(key, req);
    }
  }
  return Array.from(seen.values());
}

export function deduplicateBehaviors(behaviors: Behavior[]): Behavior[] {
  const seen = new Set<string>();
  const result: Behavior[] = [];
  for (const b of behaviors) {
    let id = b.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${b.id}-${suffix++}`;
    }
    seen.add(id);
    result.push({ ...b, id });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core spec generation logic
// ---------------------------------------------------------------------------

/** Generate a behavioral spec from capture data. */
export function generateSpec(options: { inputDir: string; specName: string }): Spec {
  const traffic = loadTraffic(options.inputDir);
  const consoleLogs = loadConsole(options.inputDir);
  const origin = traffic.length > 0 ? extractOrigin(traffic[0].url) : '';
  const pageGroups = groupByPage(traffic);

  const areas: Area[] = [];

  for (const group of pageGroups) {
    const areaId = pathToId(group.pagePath);
    const unique = deduplicateRequests(group.requests);
    const behaviors: Behavior[] = [];

    for (const req of unique) {
      const urlPath = extractPath(req.url);
      behaviors.push({
        id: pathToId(`${req.method.toLowerCase()}-${urlPath}`),
        description: `${req.method} ${urlPath} returns ${req.status}`,
        ...(req.contentType?.includes('json') ? { tags: ['api'] } : {}),
      });
    }

    if (behaviors.length > 0) {
      areas.push({
        id: areaId,
        name: group.pagePath === '/' ? 'Root' : group.pagePath.replace(/^\//, ''),
        behaviors: deduplicateBehaviors(behaviors),
      });
    }
  }

  // Add a general behaviors area for console/error expectations
  const errorCount = consoleLogs.filter((e) => e.type === 'error').length;
  if (errorCount === 0) {
    const generalBehaviors: Behavior[] = [
      { id: 'no-console-errors', description: 'No console errors appear during normal usage' },
    ];
    areas.push({ id: 'reliability', name: 'Reliability', behaviors: generalBehaviors });
  }

  if (areas.length === 0) {
    areas.push({
      id: 'general',
      name: 'General',
      behaviors: [{ id: 'app-loads', description: 'Application loads without errors' }],
    });
  }

  return {
    version: '2',
    name: options.specName,
    description: `Generated from capture: ${path.basename(options.inputDir)}`,
    target: { type: 'web', url: origin || '${TARGET_URL}' },
    areas,
    variables: {
      base_url: origin || '${TARGET_BASE_URL}',
    },
  };
}
