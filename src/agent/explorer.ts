/**
 * src/agent/explorer.ts — Adaptive exploration for untested assertions
 *
 * Analyzes a gap report to identify untested assertions, then generates
 * exploration strategies (navigation + interaction sequences) to reach
 * and test those assertions.
 */

import type { Spec, PageSpec, ScenarioStep } from '../spec/types.js';
import type { GapReport, PageResult } from '../validation/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExplorationStrategy {
  /** Pages that need to be visited */
  untestedPages: ExplorationTarget[];
  /** Scenarios that haven't been exercised */
  untestedScenarios: ExplorationTarget[];
  /** Requests that weren't observed */
  untestedRequests: ExplorationTarget[];
  /** Total number of untested items */
  totalUntested: number;
}

export interface ExplorationTarget {
  pageId: string;
  path: string;
  description: string;
  /** Navigation steps to reach the target */
  navigationSteps: NavigationPlan[];
  /** Interaction steps to trigger the assertion */
  interactionSteps: ScenarioStep[];
}

export interface NavigationPlan {
  action: 'navigate' | 'click' | 'wait';
  target: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Strategy planning
// ---------------------------------------------------------------------------

/** Analyze a spec + report to plan exploration of untested areas. */
export function planExploration(spec: Spec, report: GapReport): ExplorationStrategy {
  const untestedPages: ExplorationTarget[] = [];
  const untestedScenarios: ExplorationTarget[] = [];
  const untestedRequests: ExplorationTarget[] = [];

  for (const pageResult of report.pages) {
    const pageSpec = spec.pages?.find((p) => p.id === pageResult.pageId);
    if (!pageSpec) continue;

    // Unvisited pages
    if (!pageResult.visited) {
      untestedPages.push({
        pageId: pageResult.pageId,
        path: pageResult.path,
        description: `Visit page ${pageResult.path}`,
        navigationSteps: [
          { action: 'navigate', target: pageResult.path, description: `Navigate to ${pageResult.path}` },
        ],
        interactionSteps: [],
      });
      continue;
    }

    // Untested requests on visited pages
    const untestedReqs = pageResult.requests.filter((r) => r.status === 'untested');
    for (const req of untestedReqs) {
      untestedRequests.push({
        pageId: pageResult.pageId,
        path: pageResult.path,
        description: `Trigger ${req.method} ${req.urlPattern}`,
        navigationSteps: [
          { action: 'navigate', target: pageResult.path, description: `Navigate to ${pageResult.path}` },
        ],
        interactionSteps: inferInteractionSteps(req.method, req.urlPattern, pageSpec),
      });
    }

    // Untested scenarios
    for (const scenario of pageResult.scenarios) {
      if (scenario.status === 'untested') {
        const specScenario = pageSpec.scenarios?.find((s) => s.id === scenario.scenarioId);
        untestedScenarios.push({
          pageId: pageResult.pageId,
          path: pageResult.path,
          description: `Execute scenario ${scenario.scenarioId}`,
          navigationSteps: [
            { action: 'navigate', target: pageResult.path, description: `Navigate to ${pageResult.path}` },
          ],
          interactionSteps: specScenario?.steps ?? [],
        });
      }
    }
  }

  return {
    untestedPages,
    untestedScenarios,
    untestedRequests,
    totalUntested: untestedPages.length + untestedScenarios.length + untestedRequests.length,
  };
}

// ---------------------------------------------------------------------------
// Interaction step inference
// ---------------------------------------------------------------------------

function inferInteractionSteps(
  method: string,
  urlPattern: string,
  pageSpec: PageSpec,
): ScenarioStep[] {
  const steps: ScenarioStep[] = [];

  // For POST/PUT/PATCH requests, look for forms to fill
  if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    // Try to find a scenario that already targets this endpoint
    for (const scenario of pageSpec.scenarios ?? []) {
      const hasWaitForReq = scenario.steps.some(
        (s) =>
          s.action === 'wait_for_request' &&
          'url_pattern' in s &&
          (s as { url_pattern?: string }).url_pattern === urlPattern,
      );
      if (hasWaitForReq) {
        return scenario.steps;
      }
    }

    // Generic: click a submit button and wait for the request
    steps.push({
      action: 'click',
      selector: 'button[type="submit"], form button, input[type="submit"]',
      description: `Click submit to trigger ${method} ${urlPattern}`,
    });
    steps.push({
      action: 'wait_for_request',
      url_pattern: urlPattern,
      method,
      description: `Wait for ${method} ${urlPattern}`,
    });
  } else if (method.toUpperCase() === 'GET') {
    // For GET requests, just wait a bit — they may be triggered by page load
    steps.push({
      action: 'wait',
      duration: 2000,
      description: `Wait for ${method} ${urlPattern} to be triggered`,
    });
  }

  return steps;
}

/** Format exploration strategy as a summary. */
export function explorationToMarkdown(strategy: ExplorationStrategy): string {
  const lines: string[] = [];

  lines.push('# Exploration Strategy');
  lines.push('');
  lines.push(`**Total untested items:** ${strategy.totalUntested}`);
  lines.push('');

  if (strategy.untestedPages.length > 0) {
    lines.push('## Unvisited Pages');
    for (const target of strategy.untestedPages) {
      lines.push(`- **${target.path}** (${target.pageId})`);
    }
    lines.push('');
  }

  if (strategy.untestedRequests.length > 0) {
    lines.push('## Untested Requests');
    for (const target of strategy.untestedRequests) {
      lines.push(`- **${target.description}** on ${target.path}`);
    }
    lines.push('');
  }

  if (strategy.untestedScenarios.length > 0) {
    lines.push('## Untested Scenarios');
    for (const target of strategy.untestedScenarios) {
      lines.push(`- **${target.description}** on ${target.path}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
