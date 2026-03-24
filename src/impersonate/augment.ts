/**
 * src/impersonate/augment.ts — LLM-driven synthetic data augmentation
 *
 * Builds prompts and parses output for generating synthetic variations
 * of captured traffic using the Agent SDK.
 */

import type { CapturedTraffic } from '../capture/types.js';

/**
 * Build a condensed summary of captured traffic suitable for an LLM prompt.
 *
 * Extracts unique endpoints, request/response schemas, data patterns,
 * and value distributions.
 */
export function buildTrafficSummary(traffic: CapturedTraffic[]): string {
  const endpoints = new Map<string, {
    methods: Set<string>;
    statuses: Set<number>;
    contentTypes: Set<string>;
    sampleBodies: string[];
    requestBodies: string[];
  }>();

  for (const entry of traffic) {
    let pathname: string;
    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      continue;
    }

    if (!endpoints.has(pathname)) {
      endpoints.set(pathname, {
        methods: new Set(),
        statuses: new Set(),
        contentTypes: new Set(),
        sampleBodies: [],
        requestBodies: [],
      });
    }

    const ep = endpoints.get(pathname)!;
    ep.methods.add(entry.method);
    ep.statuses.add(entry.status);
    if (entry.contentType) ep.contentTypes.add(entry.contentType);

    // Keep up to 2 sample response bodies per endpoint
    if (entry.responseBody && ep.sampleBodies.length < 2) {
      const truncated = entry.responseBody.length > 1000
        ? entry.responseBody.slice(0, 1000) + '...(truncated)'
        : entry.responseBody;
      ep.sampleBodies.push(truncated);
    }

    // Keep up to 1 sample request body per endpoint
    if (entry.postData && ep.requestBodies.length < 1) {
      const truncated = entry.postData.length > 500
        ? entry.postData.slice(0, 500) + '...(truncated)'
        : entry.postData;
      ep.requestBodies.push(truncated);
    }
  }

  const lines: string[] = [
    `Traffic Summary: ${traffic.length} total requests across ${endpoints.size} unique endpoints`,
    '',
  ];

  for (const [pathname, ep] of endpoints) {
    lines.push(`## ${pathname}`);
    lines.push(`  Methods: ${[...ep.methods].join(', ')}`);
    lines.push(`  Statuses: ${[...ep.statuses].join(', ')}`);
    lines.push(`  Content-Types: ${[...ep.contentTypes].join(', ')}`);

    if (ep.requestBodies.length > 0) {
      lines.push('  Sample Request Body:');
      lines.push(`    ${ep.requestBodies[0]}`);
    }

    if (ep.sampleBodies.length > 0) {
      lines.push('  Sample Response Body:');
      for (const body of ep.sampleBodies) {
        lines.push(`    ${body}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the augmentation prompt that instructs the agent to generate
 * synthetic traffic variations based on the traffic summary.
 */
export function getAugmentPrompt(trafficSummary: string): string {
  return `You are a synthetic data generator for API traffic. Analyze the captured traffic
patterns below and generate realistic synthetic variations.

## Captured Traffic Patterns

${trafficSummary}

## Instructions

1. **Analyze** the traffic patterns: JSON schemas, data types, value distributions,
   field names, and relationships between endpoints.

2. **Generate 3-5x synthetic variations** for each endpoint. For each variation, produce
   a complete request/response pair with realistic but different data.

3. **Vary these fields** across variations:
   - Names, emails, usernames (use diverse, realistic values)
   - IDs (numeric and UUID formats as appropriate)
   - Counts, amounts, quantities
   - Dates and timestamps
   - Status values and enum fields
   - Array lengths

4. **Include edge cases** in some variations:
   - Empty arrays and empty objects
   - Null or missing optional fields
   - Large datasets (arrays with 10+ items)
   - Unicode characters in string fields
   - Boundary numeric values (0, negative, very large)
   - Long strings

5. **Maintain referential integrity**: if a user ID appears in one endpoint's response,
   use the same ID when that user is referenced in other endpoints.

6. **Preserve response structure**: keep the same JSON schema as the original responses,
   only vary the data values.

## Output Format

Output a JSON array of objects, each with these fields:
\`\`\`json
[
  {
    "url": "https://example.com/api/users",
    "method": "GET",
    "status": 200,
    "contentType": "application/json",
    "responseBody": "{\\"users\\": [...]}"
  }
]
\`\`\`

Output ONLY the JSON array — no markdown fences, no explanation, just valid JSON.`;
}

/**
 * Parse the agent's structured output into CapturedTraffic entries.
 *
 * Accepts the raw agent output (expected to be a JSON array of synthetic
 * traffic objects) and converts them into the CapturedTraffic format.
 */
export function parseSyntheticTraffic(agentOutput: unknown): CapturedTraffic[] {
  let entries: unknown[];

  if (typeof agentOutput === 'string') {
    // Try to extract JSON from the string (agent may wrap in markdown fences)
    let jsonStr = agentOutput.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    try {
      entries = JSON.parse(jsonStr);
    } catch {
      return [];
    }
  } else if (Array.isArray(agentOutput)) {
    entries = agentOutput;
  } else {
    return [];
  }

  if (!Array.isArray(entries)) return [];

  const now = Date.now();
  const result: CapturedTraffic[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    const url = typeof e.url === 'string' ? e.url : null;
    const method = typeof e.method === 'string' ? e.method : 'GET';
    const status = typeof e.status === 'number' ? e.status : 200;
    const contentType = typeof e.contentType === 'string' ? e.contentType : 'application/json';
    const responseBody = typeof e.responseBody === 'string'
      ? e.responseBody
      : e.responseBody != null
        ? JSON.stringify(e.responseBody)
        : null;

    if (!url) continue;

    result.push({
      url,
      method,
      postData: typeof e.postData === 'string' ? e.postData : null,
      status,
      contentType,
      ts: now,
      responseBody,
    });
  }

  return result;
}
