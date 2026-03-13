/**
 * src/spec/refiner.ts — Spec refinement from gap reports
 *
 * Analyzes a gap report against a spec and generates refinement suggestions.
 * Can also automatically apply those suggestions to produce a refined spec.
 */

import type { Spec, PageSpec, ExpectedRequest } from './types.js';
import type { GapReport, PageResult, RequestResult } from '../validation/types.js';

// ---------------------------------------------------------------------------
// Suggestion types
// ---------------------------------------------------------------------------

export type RefinementSuggestion =
  | AddAssertionSuggestion
  | FixAssertionSuggestion
  | AddScenarioSuggestion
  | RemoveAssertionSuggestion;

interface BaseSuggestion {
  pageId: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AddAssertionSuggestion extends BaseSuggestion {
  type: 'add_assertion';
  assertion: ExpectedRequest;
}

export interface FixAssertionSuggestion extends BaseSuggestion {
  type: 'fix_assertion';
  method: string;
  urlPattern: string;
  fix: Partial<ExpectedRequest>;
}

export interface AddScenarioSuggestion extends BaseSuggestion {
  type: 'add_scenario';
  scenarioId: string;
  description: string;
}

export interface RemoveAssertionSuggestion extends BaseSuggestion {
  type: 'remove_assertion';
  method: string;
  urlPattern: string;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Analyze gaps and generate refinement suggestions. */
export function analyzeGaps(spec: Spec, report: GapReport): RefinementSuggestion[] {
  const suggestions: RefinementSuggestion[] = [];

  for (const pageResult of report.pages) {
    const pageSpec = spec.pages?.find((p) => p.id === pageResult.pageId);
    if (!pageSpec) continue;

    // Analyze request failures
    for (const req of pageResult.requests) {
      if (req.status === 'failed') {
        const suggestion = analyzeRequestFailure(pageSpec, pageResult, req);
        if (suggestion) suggestions.push(suggestion);
      }
    }

    // Look for untested pages that should have scenarios
    if (!pageResult.visited) {
      suggestions.push({
        type: 'add_scenario',
        pageId: pageResult.pageId,
        scenarioId: `navigate-${pageResult.pageId}`,
        description: `Add navigation scenario to reach ${pageResult.path}`,
        reason: `Page ${pageResult.path} was not visited during testing`,
        confidence: 'medium',
      });
    }
  }

  return suggestions;
}

function analyzeRequestFailure(
  _pageSpec: PageSpec,
  pageResult: PageResult,
  req: RequestResult,
): RefinementSuggestion | null {
  const reason = req.reason ?? '';

  // Wrong status code
  if (reason.includes('Expected status')) {
    const actualMatch = reason.match(/got (\d+)/);
    const actual = actualMatch ? parseInt(actualMatch[1], 10) : undefined;

    if (actual !== undefined) {
      // If we got a valid response but wrong status, suggest updating
      return {
        type: 'fix_assertion',
        pageId: pageResult.pageId,
        method: req.method,
        urlPattern: req.urlPattern,
        fix: {
          response: { status_in: [req.expectedStatus!, actual] },
        },
        reason: `Expected status ${req.expectedStatus} but got ${actual}`,
        confidence: 'medium',
      };
    }
  }

  // Schema failure
  if (reason.includes('schema validation failed')) {
    return {
      type: 'fix_assertion',
      pageId: pageResult.pageId,
      method: req.method,
      urlPattern: req.urlPattern,
      fix: {
        response: { body_schema: undefined },
      },
      reason: 'Response body schema validation failed — consider relaxing the schema',
      confidence: 'low',
    };
  }

  // Missing endpoint — no matching request found
  if (reason.includes('No') && reason.includes('found in capture')) {
    return {
      type: 'remove_assertion',
      pageId: pageResult.pageId,
      method: req.method,
      urlPattern: req.urlPattern,
      reason: `No ${req.method} request matching "${req.urlPattern}" was observed — endpoint may not exist or may have a different pattern`,
      confidence: 'low',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Apply suggestions
// ---------------------------------------------------------------------------

/** Apply refinement suggestions to produce a refined spec. */
export function applyRefinements(
  spec: Spec,
  suggestions: RefinementSuggestion[],
): Spec {
  // Deep clone the spec
  const refined: Spec = JSON.parse(JSON.stringify(spec));

  for (const suggestion of suggestions) {
    const page = refined.pages?.find((p) => p.id === suggestion.pageId);
    if (!page) continue;

    switch (suggestion.type) {
      case 'add_assertion':
        if (!page.expected_requests) page.expected_requests = [];
        page.expected_requests.push(suggestion.assertion);
        break;

      case 'fix_assertion': {
        const req = page.expected_requests?.find(
          (r) =>
            r.method === suggestion.method &&
            r.url_pattern === suggestion.urlPattern,
        );
        if (req && suggestion.fix.response) {
          if (!req.response) req.response = {};
          if (suggestion.fix.response.status_in) {
            req.response.status_in = suggestion.fix.response.status_in;
            delete req.response.status;
          }
          if (suggestion.fix.response.body_schema === undefined && 'body_schema' in suggestion.fix.response) {
            delete req.response.body_schema;
          }
        }
        break;
      }

      case 'remove_assertion': {
        if (page.expected_requests) {
          page.expected_requests = page.expected_requests.filter(
            (r) =>
              !(r.method === suggestion.method && r.url_pattern === suggestion.urlPattern),
          );
        }
        break;
      }

      case 'add_scenario': {
        if (!page.scenarios) page.scenarios = [];
        page.scenarios.push({
          id: suggestion.scenarioId,
          description: suggestion.description,
          steps: [
            {
              action: 'wait',
              duration: 1000,
              description: 'Placeholder — replace with actual interaction steps',
            },
          ],
        });
        break;
      }
    }
  }

  return refined;
}

/** Format suggestions as Markdown. */
export function suggestionsToMarkdown(suggestions: RefinementSuggestion[]): string {
  const lines: string[] = [];
  lines.push('# Refinement Suggestions');
  lines.push('');

  if (suggestions.length === 0) {
    lines.push('No suggestions — spec appears well-aligned with capture data.');
    return lines.join('\n');
  }

  lines.push(`Found **${suggestions.length}** suggestions:`);
  lines.push('');

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const badge = s.confidence === 'high' ? '[HIGH]' : s.confidence === 'medium' ? '[MEDIUM]' : '[LOW]';
    lines.push(`### ${i + 1}. ${badge} ${s.type} (page: \`${s.pageId}\`)`);
    lines.push(`> ${s.reason}`);
    lines.push('');

    if (s.type === 'fix_assertion') {
      lines.push(`**Target:** \`${s.method} ${s.urlPattern}\``);
      if (s.fix.response?.status_in) {
        lines.push(`**Fix:** Accept status codes: ${s.fix.response.status_in.join(', ')}`);
      }
    } else if (s.type === 'remove_assertion') {
      lines.push(`**Remove:** \`${s.method} ${s.urlPattern}\``);
    } else if (s.type === 'add_scenario') {
      lines.push(`**Add scenario:** \`${s.scenarioId}\` — ${s.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
