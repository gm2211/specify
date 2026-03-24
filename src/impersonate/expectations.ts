/**
 * src/impersonate/expectations.ts — Convert captured traffic to MockServer expectations
 *
 * Transforms CapturedTraffic entries into MockServer expectation JSON,
 * handling deduplication, round-robin multi-response endpoints, and
 * filtering of static assets.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CapturedTraffic } from '../capture/types.js';
import type { MockServerExpectation, MockServerRequest, MockServerResponse } from './types.js';

/** File extensions considered static assets — filtered out of expectations. */
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.cjs',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.map', '.br', '.gz',
]);

function isStaticAsset(urlPath: string): boolean {
  const ext = path.extname(urlPath).toLowerCase();
  return STATIC_EXTENSIONS.has(ext);
}

function parseQueryParams(searchParams: URLSearchParams): Record<string, string[]> | undefined {
  const params: Record<string, string[]> = {};
  let hasParams = false;
  for (const [key, value] of searchParams) {
    if (!params[key]) params[key] = [];
    params[key].push(value);
    hasParams = true;
  }
  return hasParams ? params : undefined;
}

function buildRequest(traffic: CapturedTraffic, parsedUrl: URL): MockServerRequest {
  const request: MockServerRequest = {
    method: traffic.method,
    path: parsedUrl.pathname,
  };

  const queryParams = parseQueryParams(parsedUrl.searchParams);
  if (queryParams) {
    request.queryStringParameters = queryParams;
  }

  if ((traffic.method === 'POST' || traffic.method === 'PUT' || traffic.method === 'PATCH') && traffic.postData) {
    if (traffic.contentType?.includes('application/json')) {
      try {
        request.body = { type: 'JSON', json: JSON.parse(traffic.postData) };
      } catch {
        request.body = { type: 'STRING', string: traffic.postData };
      }
    } else {
      request.body = { type: 'STRING', string: traffic.postData };
    }
  }

  return request;
}

function buildResponse(traffic: CapturedTraffic): MockServerResponse {
  const response: MockServerResponse = {
    statusCode: traffic.status,
  };

  if (traffic.contentType) {
    response.headers = {
      'Content-Type': [traffic.contentType],
    };
  }

  if (traffic.responseBody) {
    response.body = traffic.responseBody;
  }

  return response;
}

/**
 * Convert an array of captured traffic entries into MockServer expectations.
 *
 * - Filters out static assets (CSS, JS, images, fonts)
 * - Deduplicates by method+path: single-response endpoints get `times: { unlimited: true }`,
 *   multi-response endpoints omit `times` so MockServer cycles through them round-robin
 */
export function trafficToExpectations(traffic: CapturedTraffic[]): MockServerExpectation[] {
  // Group by method+path for deduplication
  const grouped = new Map<string, CapturedTraffic[]>();

  for (const entry of traffic) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(entry.url);
    } catch {
      continue;
    }

    if (isStaticAsset(parsedUrl.pathname)) continue;

    const key = `${entry.method}::${parsedUrl.pathname}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(entry);
  }

  const expectations: MockServerExpectation[] = [];

  for (const [, entries] of grouped) {
    const isSingleResponse = entries.length === 1;

    for (const entry of entries) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(entry.url);
      } catch {
        continue;
      }

      const expectation: MockServerExpectation = {
        httpRequest: buildRequest(entry, parsedUrl),
        httpResponse: buildResponse(entry),
      };

      if (isSingleResponse) {
        expectation.times = { unlimited: true };
      }

      expectations.push(expectation);
    }
  }

  return expectations;
}

/**
 * Write expectations to a JSON file in the given output directory.
 * Returns the absolute path to the written file.
 */
export function saveExpectations(expectations: MockServerExpectation[], outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, 'expectations.json');
  fs.writeFileSync(filePath, JSON.stringify(expectations, null, 2), 'utf-8');
  return filePath;
}
