/**
 * src/spec/migrate.ts — Convert v1 specs to v2 behavioral format
 *
 * Transforms computable v1 specs (matchers, selectors, step sequences)
 * into behavioral v2 specs (plain-language claims grouped into areas).
 */

import type { SpecV1 } from './types.js';
import type { SpecV2, Area, Behavior, AssumptionV2, HookStepV2, HooksV2 } from './types-v2.js';

/**
 * Convert a v1 spec to v2 format.
 *
 * Mapping:
 *   - Narrative sections → areas (section name → area id/name, prose carries over)
 *   - Requirements → behaviors (id + description, drop validation_plan/evidence_format/checks)
 *   - CLI commands → behaviors (description carries over, args/assertions dropped)
 *   - Pages → behaviors (visual assertions become behavioral descriptions)
 *   - Typed assumptions → plain-language assumptions with check hints
 *   - Typed hooks → { name, run } strings
 */
export function migrateV1toV2(spec: SpecV1): SpecV2 {
  const areas: Area[] = [];

  // Build a map of item ID → narrative section for distributing into themed areas
  const coverMap = new Map<string, { section: string; prose?: string }>();
  if (spec.narrative) {
    for (const section of spec.narrative) {
      for (const id of section.covers ?? []) {
        coverMap.set(id, { section: section.section, prose: section.prose });
      }
    }
  }

  // Build all behaviors from CLI commands and scenarios
  const allCliBehaviors = new Map<string, Behavior>();
  if (spec.cli?.commands) {
    for (const cmd of spec.cli.commands) {
      allCliBehaviors.set(cmd.id, {
        id: cmd.id,
        description: cmd.description || `${cmd.args.join(' ')} exits successfully`,
      });
    }
  }
  if (spec.cli?.scenarios) {
    for (const scenario of spec.cli.scenarios) {
      allCliBehaviors.set(scenario.id, {
        id: scenario.id,
        description: scenario.description || `Scenario: ${scenario.id}`,
      });
    }
  }

  // 1. Narrative sections with requirements → areas
  if (spec.narrative) {
    for (const section of spec.narrative) {
      const behaviors: Behavior[] = [];

      // Add requirements as behaviors
      if (section.requirements) {
        for (const req of section.requirements) {
          behaviors.push({
            id: req.id,
            description: req.description,
            ...(req.narrative ? { details: req.narrative } : {}),
          });
        }
      }

      // Add CLI behaviors that this section covers
      for (const id of section.covers ?? []) {
        const cliBehavior = allCliBehaviors.get(id);
        if (cliBehavior) {
          behaviors.push(cliBehavior);
          allCliBehaviors.delete(id);  // claimed
        }
      }

      if (behaviors.length > 0) {
        areas.push({
          id: toKebabCase(section.section),
          name: section.section,
          ...(section.prose ? { prose: section.prose } : {}),
          behaviors,
        });
      }
    }
  }

  // 2. Top-level requirements → "requirements" area (if not already covered by narrative)
  if (spec.requirements) {
    const narrativeReqIds = new Set(
      (spec.narrative ?? []).flatMap((s) => (s.requirements ?? []).map((r) => r.id)),
    );
    const uncoveredReqs = spec.requirements.filter((r) => !narrativeReqIds.has(r.id));

    if (uncoveredReqs.length > 0) {
      areas.push({
        id: 'requirements',
        name: 'Requirements',
        behaviors: uncoveredReqs.map((req) => ({
          id: req.id,
          description: req.description,
          ...(req.narrative ? { details: req.narrative } : {}),
        })),
      });
    }
  }

  // 3. Remaining unclaimed CLI behaviors → "cli" area
  if (allCliBehaviors.size > 0) {
    areas.push({
      id: 'cli-commands',
      name: 'CLI Commands',
      behaviors: Array.from(allCliBehaviors.values()),
    });
  }

  // 5. Pages → behaviors in page-specific areas
  if (spec.pages) {
    for (const page of spec.pages) {
      const behaviors: Behavior[] = [];

      // Visual assertions → behavioral descriptions
      if (page.visual_assertions) {
        for (const va of page.visual_assertions) {
          if (va.description) {
            behaviors.push({
              id: toKebabCase(va.description).slice(0, 60),
              description: va.description,
            });
          } else {
            behaviors.push({
              id: `${page.id}-${va.type}`,
              description: visualAssertionToDescription(va),
            });
          }
        }
      }

      // Expected requests → behavioral descriptions
      if (page.expected_requests) {
        for (const req of page.expected_requests) {
          behaviors.push({
            id: toKebabCase(req.description || `${req.method}-${req.url_pattern}`).slice(0, 60),
            description: req.description || `${req.method} ${req.url_pattern} returns expected response`,
          });
        }
      }

      // Scenarios → behavioral descriptions
      if (page.scenarios) {
        for (const scenario of page.scenarios) {
          behaviors.push({
            id: scenario.id,
            description: scenario.description || `Scenario: ${scenario.id}`,
          });
        }
      }

      if (behaviors.length > 0) {
        areas.push({
          id: page.id,
          name: `Page: ${page.path}`,
          behaviors: deduplicateBehaviors(behaviors),
        });
      }
    }
  }

  // 6. Flows → behaviors in a "flows" area
  if (spec.flows && spec.flows.length > 0) {
    areas.push({
      id: 'flows',
      name: 'User Flows',
      behaviors: deduplicateBehaviors(spec.flows.map((flow) => ({
        id: flow.id,
        description: flow.description || `Flow: ${flow.id}`,
      }))),
    });
  }

  // Build target from available info
  const target = buildTarget(spec);

  // Build assumptions
  const assumptions = migrateAssumptions(spec);

  // Build hooks
  const hooks = migrateHooks(spec);

  // Ensure at least one area
  if (areas.length === 0) {
    areas.push({
      id: 'general',
      name: 'General',
      behaviors: [{ id: 'placeholder', description: spec.description || 'TBD' }],
    });
  }

  const result: SpecV2 = {
    version: '2',
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    target,
    ...(spec.variables ? { variables: spec.variables } : {}),
    ...(assumptions.length > 0 ? { assumptions } : {}),
    ...(hooks ? { hooks } : {}),
    areas,
    ...(spec.narrative_path ? { narrative_path: spec.narrative_path } : {}),
  };

  return result;
}

function buildTarget(spec: SpecV1): SpecV2['target'] {
  if (spec.cli?.binary) {
    const target: { type: 'cli'; binary: string; env?: Record<string, string>; timeout_ms?: number } = {
      type: 'cli',
      binary: spec.cli.binary,
    };
    if (spec.cli.env && Object.keys(spec.cli.env).length > 0) target.env = spec.cli.env;
    if (spec.cli.timeout_ms) target.timeout_ms = spec.cli.timeout_ms;
    return target;
  }
  // Try to infer URL from assumptions
  if (spec.assumptions) {
    for (const a of spec.assumptions) {
      if (a.type === 'url_reachable') {
        return { type: 'web', url: a.url };
      }
    }
  }
  // Try to infer from pages (web spec without explicit URL)
  if (spec.pages && spec.pages.length > 0) {
    return { type: 'web', url: '${TARGET_URL}' };
  }
  // Default to CLI
  return { type: 'cli', binary: '.' };
}

function migrateAssumptions(spec: SpecV1): AssumptionV2[] {
  if (!spec.assumptions) return [];
  return spec.assumptions.map((a) => {
    switch (a.type) {
      case 'url_reachable':
        return { description: `${a.url} is reachable`, check: `curl -sf ${a.url}` };
      case 'env_var_set':
        return { description: `Environment variable ${a.name} is set`, check: `test -n "$${a.name}"` };
      case 'api_returns':
        return {
          description: a.description || `${a.method ?? 'GET'} ${a.url} returns ${a.status ?? 200}`,
          check: `curl -sf -o /dev/null -w '%{http_code}' ${a.url}`,
        };
      case 'selector_exists':
        return {
          description: a.description || `Element ${a.selector} exists on ${a.url}`,
          check: `curl -sf ${a.url} | grep -q '${a.selector}'`,
        };
      default:
        return { description: (a as { description?: string }).description ?? 'Unknown assumption' };
    }
  });
}

function migrateHooks(spec: SpecV1): HooksV2 | undefined {
  if (!spec.hooks) return undefined;

  const result: HooksV2 = {};

  if (spec.hooks.setup) {
    result.setup = spec.hooks.setup.map(hookToV2);
  }
  if (spec.hooks.teardown) {
    result.teardown = spec.hooks.teardown.map(hookToV2);
  }

  return result;
}

function hookToV2(hook: import('./types.js').HookStep): HookStepV2 {
  const h = hook as {
    name: string; type: string; command?: string;
    method?: string; url?: string; headers?: Record<string, string>;
    body?: unknown; save_as?: string;
  };
  if (h.type === 'shell') {
    return {
      name: h.name,
      run: h.command ?? '',
      ...(h.save_as ? { save_as: h.save_as } : {}),
    };
  }
  // api_call → curl command with headers and body
  const parts = [`curl -X ${h.method ?? 'GET'}`];
  if (h.headers) {
    for (const [key, val] of Object.entries(h.headers)) {
      parts.push(`-H '${key}: ${val}'`);
    }
  }
  if (h.body) {
    parts.push(`-d '${JSON.stringify(h.body)}'`);
  }
  parts.push(h.url ?? '');
  return {
    name: h.name,
    run: parts.join(' '),
    ...(h.save_as ? { save_as: h.save_as } : {}),
  };
}

function visualAssertionToDescription(va: { type: string; selector?: string; text?: string; pattern?: string }): string {
  switch (va.type) {
    case 'element_exists':
      return `Element "${va.selector}" exists on the page`;
    case 'text_contains':
      return `Element "${va.selector}" contains text "${va.text}"`;
    case 'text_matches':
      return `Element "${va.selector}" text matches pattern ${va.pattern}`;
    case 'screenshot_region':
      return `Region "${va.selector}" renders correctly`;
    case 'element_count':
      return `Expected number of "${va.selector}" elements`;
    default:
      return `Visual assertion: ${va.type}`;
  }
}

function toKebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
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
