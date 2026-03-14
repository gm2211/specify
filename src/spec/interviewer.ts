/**
 * src/spec/interviewer.ts — Structured product interview engine
 *
 * Guides a human through defining their product in a structured way.
 * Produces two outputs:
 *   1. A computable Spec (YAML)
 *   2. A NarrativeDocument (Markdown) linking prose to spec items
 *
 * Interview flow:
 *   1. Product identity (name, description, base URL)
 *   2. User roles (who uses this?)
 *   3. Pages and views (what do users see?)
 *   4. Key interactions per page (what do users do?)
 *   5. User journeys / flows (multi-page workflows)
 *   6. API contracts (what data flows through?)
 *   7. Error handling (what should NOT happen?)
 *   8. Non-functional requirements (performance, accessibility)
 *   9. Review and finalize
 */

import type {
  Spec,
  PageSpec,
  FlowSpec,
  FlowStep,
  ScenarioSpec,
  ScenarioStep,
  VisualAssertion,
  ExpectedRequest,
  DefaultProperties,
  Assumption,
} from './types.js';
import type { NarrativeDocument, NarrativeSection } from './narrative.js';

// ---------------------------------------------------------------------------
// Interview context (accumulated answers)
// ---------------------------------------------------------------------------

export interface InterviewContext {
  // Product identity
  productName: string;
  description: string;
  baseUrl: string;

  // User roles
  roles: Array<{ name: string; description: string }>;

  // Pages
  pages: Array<{
    id: string;
    path: string;
    title: string;
    description: string;
    role?: string;
    elements: Array<{ selector: string; description: string }>;
    interactions: Array<{
      id: string;
      description: string;
      steps: ScenarioStep[];
    }>;
    apiCalls: Array<{
      method: string;
      urlPattern: string;
      description: string;
      expectedStatus?: number;
    }>;
  }>;

  // Flows
  flows: Array<{
    id: string;
    description: string;
    role?: string;
    pageSequence: string[]; // page IDs in order
    detailedSteps: FlowStep[];
  }>;

  // Error handling
  errorBehaviors: Array<{ description: string; page?: string }>;

  // Defaults
  defaults: {
    no5xx: boolean;
    noConsoleErrors: boolean;
    noUncaughtExceptions: boolean;
    pageLoadTimeoutMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Prompt helpers interface (injected by the caller — readline, TUI, etc.)
// ---------------------------------------------------------------------------

export interface PromptHelpers {
  ask: (question: string, defaultVal?: string) => Promise<string>;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  choose: (question: string, options: string[]) => Promise<number>;
  say: (message: string) => void;
  section: (title: string) => void;
}

// ---------------------------------------------------------------------------
// Main interview runner
// ---------------------------------------------------------------------------

export async function runInterview(prompts: PromptHelpers): Promise<{ spec: Spec; narrative: NarrativeDocument }> {
  const ctx: InterviewContext = {
    productName: '',
    description: '',
    baseUrl: '',
    roles: [],
    pages: [],
    flows: [],
    errorBehaviors: [],
    defaults: { no5xx: true, noConsoleErrors: true, noUncaughtExceptions: true },
  };

  // Step 1: Product identity
  prompts.section('Product Identity');
  prompts.say('Let\'s start by understanding what you\'re building.');

  ctx.productName = await prompts.ask('What is your product called?');
  ctx.description = await prompts.ask('Describe it in one sentence');
  ctx.baseUrl = await prompts.ask('What URL will it run at?', 'http://localhost:3000');

  // Step 2: User roles
  prompts.section('User Roles');
  prompts.say('Who uses this product? (e.g., "visitor", "admin", "customer")');

  let addRole = true;
  while (addRole) {
    const roleName = await prompts.ask('Role name (empty to skip)');
    if (!roleName) break;
    const roleDesc = await prompts.ask(`What does a ${roleName} do?`);
    ctx.roles.push({ name: roleName, description: roleDesc });
    addRole = await prompts.confirm('Add another role?', false);
  }

  // Step 3: Pages and views
  prompts.section('Pages & Views');
  prompts.say('What pages or screens does your product have?');

  let addPage = true;
  while (addPage) {
    const pagePath = await prompts.ask('Page URL path (e.g., /dashboard) — empty to stop');
    if (!pagePath) break;

    const pageTitle = await prompts.ask('Page title (what appears in the browser tab)?', pagePath.replace(/^\//, ''));
    const pageDesc = await prompts.ask('What is this page for?');
    const pageId = slugify(pageTitle || pagePath);

    // Key elements
    prompts.say('What key elements should be visible on this page?');
    const elements: Array<{ selector: string; description: string }> = [];
    let addElement = true;
    while (addElement) {
      const desc = await prompts.ask('Element description (e.g., "navigation bar", "submit button") — empty to stop');
      if (!desc) break;
      const selector = await prompts.ask(`CSS selector for "${desc}"`, guessSelector(desc));
      elements.push({ selector, description: desc });
      addElement = await prompts.confirm('Add another element?', true);
    }

    // Interactions
    prompts.say('What can a user do on this page?');
    const interactions: typeof ctx.pages[0]['interactions'] = [];
    let addInteraction = true;
    while (addInteraction) {
      const interactionDesc = await prompts.ask('Describe an interaction (e.g., "submit the login form") — empty to stop');
      if (!interactionDesc) break;
      const interactionId = slugify(interactionDesc);

      prompts.say('Walk me through the steps:');
      const steps = await collectSteps(prompts);

      interactions.push({ id: interactionId, description: interactionDesc, steps });
      addInteraction = await prompts.confirm('Add another interaction?', false);
    }

    // API calls
    const hasApi = await prompts.confirm('Does this page make API calls?', false);
    const apiCalls: typeof ctx.pages[0]['apiCalls'] = [];
    if (hasApi) {
      let addApi = true;
      while (addApi) {
        const apiDesc = await prompts.ask('Describe the API call — empty to stop');
        if (!apiDesc) break;
        const method = await prompts.ask('HTTP method', 'GET');
        const urlPattern = await prompts.ask('URL pattern (e.g., /api/users)');
        const statusStr = await prompts.ask('Expected status code', '200');
        apiCalls.push({
          method: method.toUpperCase(),
          urlPattern,
          description: apiDesc,
          expectedStatus: parseInt(statusStr, 10),
        });
        addApi = await prompts.confirm('Add another API call?', false);
      }
    }

    ctx.pages.push({
      id: pageId,
      path: pagePath,
      title: pageTitle,
      description: pageDesc,
      elements,
      interactions,
      apiCalls,
    });

    addPage = await prompts.confirm('Add another page?', true);
  }

  // Step 4: User journeys / flows
  if (ctx.pages.length > 1) {
    prompts.section('User Journeys');
    prompts.say('Flows connect multiple pages into user journeys (e.g., login -> dashboard -> settings).');

    let addFlow = await prompts.confirm('Define a multi-page flow?', true);
    while (addFlow) {
      const flowDesc = await prompts.ask('Describe this journey');
      const flowId = slugify(flowDesc);

      prompts.say(`Available pages: ${ctx.pages.map(p => p.id).join(', ')}`);

      const pageSequence: string[] = [];
      const detailedSteps: FlowStep[] = [];

      let addFlowPage = true;
      while (addFlowPage) {
        const pageId = await prompts.ask('Next page in the flow (page ID) — empty to stop');
        if (!pageId) break;

        const matchedPage = ctx.pages.find(p => p.id === pageId);
        if (!matchedPage) {
          prompts.say(`Page "${pageId}" not found. Available: ${ctx.pages.map(p => p.id).join(', ')}`);
          continue;
        }

        pageSequence.push(pageId);
        detailedSteps.push({ navigate: matchedPage.path } as FlowStep);
        detailedSteps.push({ assert_page: pageId } as FlowStep);

        const hasAction = await prompts.confirm('Any actions on this page before moving to the next?', false);
        if (hasAction) {
          const steps = await collectSteps(prompts);
          for (const step of steps) {
            detailedSteps.push(step as FlowStep);
          }
        }

        addFlowPage = await prompts.confirm('Add another page to this flow?', true);
      }

      ctx.flows.push({ id: flowId, description: flowDesc, pageSequence, detailedSteps });
      addFlow = await prompts.confirm('Add another flow?', false);
    }
  }

  // Step 5: Error handling / defaults
  prompts.section('Error Handling & Defaults');

  ctx.defaults.no5xx = await prompts.confirm('Should all pages be free of HTTP 5xx errors?', true);
  ctx.defaults.noConsoleErrors = await prompts.confirm('Should all pages be free of console errors?', true);

  const hasTimeout = await prompts.confirm('Set a page load timeout?', false);
  if (hasTimeout) {
    const ms = await prompts.ask('Max page load time (ms)', '5000');
    ctx.defaults.pageLoadTimeoutMs = parseInt(ms, 10);
  }

  // Build outputs
  const spec = buildSpec(ctx);
  const narrative = buildNarrative(ctx);

  return { spec, narrative };
}

// ---------------------------------------------------------------------------
// Step collector
// ---------------------------------------------------------------------------

async function collectSteps(prompts: PromptHelpers): Promise<ScenarioStep[]> {
  const steps: ScenarioStep[] = [];

  let addStep = true;
  while (addStep) {
    const actionIdx = await prompts.choose('Step type:', [
      'click — Click an element',
      'fill — Type into an input',
      'select — Choose from a dropdown',
      'hover — Hover over an element',
      'assert_visible — Check something is visible',
      'assert_text — Check text content',
      'wait_for_navigation — Wait for page change',
      'wait_for_request — Wait for an API call',
      'keypress — Press a key',
      '(done — no more steps)',
    ]);

    const actions = ['click', 'fill', 'select', 'hover', 'assert_visible', 'assert_text', 'wait_for_navigation', 'wait_for_request', 'keypress'] as const;
    if (actionIdx >= actions.length) break;

    const action = actions[actionIdx];
    const step = await buildStep(action, prompts);
    if (step) steps.push(step);

    addStep = await prompts.confirm('Add another step?', true);
  }

  return steps;
}

async function buildStep(action: string, prompts: PromptHelpers): Promise<ScenarioStep | null> {
  switch (action) {
    case 'click': {
      const selector = await prompts.ask('CSS selector to click');
      return { action: 'click', selector };
    }
    case 'fill': {
      const selector = await prompts.ask('CSS selector of the input');
      const value = await prompts.ask('Value to type');
      return { action: 'fill', selector, value };
    }
    case 'select': {
      const selector = await prompts.ask('CSS selector of the dropdown');
      const value = await prompts.ask('Option value to select');
      return { action: 'select', selector, value };
    }
    case 'hover': {
      const selector = await prompts.ask('CSS selector to hover');
      return { action: 'hover', selector };
    }
    case 'assert_visible': {
      const selector = await prompts.ask('CSS selector that should be visible');
      return { action: 'assert_visible', selector };
    }
    case 'assert_text': {
      const selector = await prompts.ask('CSS selector');
      const text = await prompts.ask('Expected text');
      return { action: 'assert_text', selector, text };
    }
    case 'wait_for_navigation': {
      const url_pattern = await prompts.ask('URL pattern to wait for');
      return { action: 'wait_for_navigation', url_pattern };
    }
    case 'wait_for_request': {
      const url_pattern = await prompts.ask('API URL pattern to wait for');
      const method = await prompts.ask('HTTP method (empty for any)', '');
      return { action: 'wait_for_request', url_pattern, ...(method ? { method } : {}) };
    }
    case 'keypress': {
      const key = await prompts.ask('Key to press (e.g., Enter, Tab, Control+A)');
      return { action: 'keypress', key };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Build Spec from InterviewContext
// ---------------------------------------------------------------------------

function buildSpec(ctx: InterviewContext): Spec {
  const pages: PageSpec[] = ctx.pages.map(p => {
    const visual_assertions: VisualAssertion[] = p.elements.map(e => ({
      type: 'element_exists' as const,
      selector: e.selector,
      description: e.description,
    }));

    const scenarios: ScenarioSpec[] = p.interactions.map(i => ({
      id: i.id,
      description: i.description,
      steps: i.steps,
    }));

    const expected_requests: ExpectedRequest[] = p.apiCalls.map(a => ({
      method: a.method,
      url_pattern: a.urlPattern,
      description: a.description,
      ...(a.expectedStatus ? { response: { status: a.expectedStatus } } : {}),
    }));

    return {
      id: p.id,
      path: p.path,
      title: p.title,
      ...(visual_assertions.length > 0 ? { visual_assertions } : {}),
      ...(scenarios.length > 0 ? { scenarios } : {}),
      ...(expected_requests.length > 0 ? { expected_requests } : {}),
      ...(ctx.defaults.noConsoleErrors ? { console_expectations: [{ level: 'error', count: 0 }] } : {}),
    };
  });

  const flows: FlowSpec[] = ctx.flows.map(f => ({
    id: f.id,
    description: f.description,
    steps: f.detailedSteps,
  }));

  const defaults: DefaultProperties = {};
  if (ctx.defaults.no5xx) defaults.no_5xx = true;
  if (ctx.defaults.noConsoleErrors) defaults.no_console_errors = true;
  if (ctx.defaults.noUncaughtExceptions) defaults.no_uncaught_exceptions = true;
  if (ctx.defaults.pageLoadTimeoutMs) defaults.page_load_timeout_ms = ctx.defaults.pageLoadTimeoutMs;

  const assumptions: Assumption[] = [
    {
      type: 'url_reachable',
      url: '{{base_url}}',
      description: `${ctx.productName} is running`,
    },
  ];

  return {
    version: '1.0',
    name: `${ctx.productName} Spec`,
    description: ctx.description,
    ...(pages.length > 0 ? { pages } : {}),
    ...(flows.length > 0 ? { flows } : {}),
    defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
    assumptions,
    variables: { base_url: ctx.baseUrl },
  };
}

// ---------------------------------------------------------------------------
// Build NarrativeDocument from InterviewContext
// ---------------------------------------------------------------------------

function buildNarrative(ctx: InterviewContext): NarrativeDocument {
  const sections: NarrativeSection[] = [];

  // User roles section (if any)
  if (ctx.roles.length > 0) {
    sections.push({
      title: 'User Roles',
      body: ctx.roles.map(r => `- **${r.name}**: ${r.description}`).join('\n'),
      specRefs: [],
      children: [],
    });
  }

  // Pages
  for (const page of ctx.pages) {
    const children: NarrativeSection[] = [];

    // Interactions as subsections
    for (const interaction of page.interactions) {
      children.push({
        title: interaction.description,
        body: `This scenario verifies that a user can ${interaction.description.toLowerCase()}.\n\nSteps:\n${interaction.steps.map((s, i) => `${i + 1}. ${stepToNarrative(s)}`).join('\n')}`,
        specRefs: [`scenario:${page.id}/${interaction.id}`],
        children: [],
      });
    }

    // API calls as a subsection
    if (page.apiCalls.length > 0) {
      children.push({
        title: 'API Contracts',
        body: page.apiCalls.map(a => `- **${a.method} ${a.urlPattern}**: ${a.description}${a.expectedStatus ? ` (expects ${a.expectedStatus})` : ''}`).join('\n'),
        specRefs: page.apiCalls.map(a => `request:${page.id}/${a.method}:${a.urlPattern}`),
        children: [],
      });
    }

    sections.push({
      title: page.title || page.path,
      body: page.description + (page.elements.length > 0
        ? `\n\nKey elements:\n${page.elements.map(e => `- ${e.description} (\`${e.selector}\`)`).join('\n')}`
        : ''),
      specRefs: [`page:${page.id}`],
      children,
    });
  }

  // Flows
  for (const flow of ctx.flows) {
    sections.push({
      title: flow.description,
      body: `This user journey connects the following pages: ${flow.pageSequence.join(' → ')}`,
      specRefs: [`flow:${flow.id}`],
      children: [],
    });
  }

  // Error handling
  if (ctx.defaults.no5xx || ctx.defaults.noConsoleErrors) {
    const items: string[] = [];
    if (ctx.defaults.no5xx) items.push('No HTTP 5xx errors on any page');
    if (ctx.defaults.noConsoleErrors) items.push('No console errors on any page');
    if (ctx.defaults.noUncaughtExceptions) items.push('No uncaught exceptions');
    if (ctx.defaults.pageLoadTimeoutMs) items.push(`Pages load within ${ctx.defaults.pageLoadTimeoutMs}ms`);

    sections.push({
      title: 'Error Handling & Quality',
      body: items.map(i => `- ${i}`).join('\n'),
      specRefs: ['defaults'],
      children: [],
    });
  }

  return {
    title: ctx.productName,
    overview: ctx.description,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function guessSelector(description: string): string {
  const lower = description.toLowerCase();
  if (lower.includes('button')) return 'button';
  if (lower.includes('form')) return 'form';
  if (lower.includes('nav')) return 'nav';
  if (lower.includes('header')) return 'header';
  if (lower.includes('footer')) return 'footer';
  if (lower.includes('input')) return 'input';
  if (lower.includes('table')) return 'table';
  if (lower.includes('list')) return 'ul';
  if (lower.includes('link')) return 'a';
  if (lower.includes('image') || lower.includes('logo')) return 'img';
  return `[data-testid=${slugify(description)}]`;
}

function stepToNarrative(step: ScenarioStep): string {
  switch (step.action) {
    case 'click': return `Click on \`${step.selector}\``;
    case 'fill': return `Type "${step.value}" into \`${step.selector}\``;
    case 'select': return `Select "${step.value}" from \`${step.selector}\``;
    case 'hover': return `Hover over \`${step.selector}\``;
    case 'assert_visible': return `Verify \`${step.selector}\` is visible`;
    case 'assert_text': return `Verify \`${step.selector}\` contains "${step.text}"`;
    case 'assert_not_visible': return `Verify \`${step.selector}\` is not visible`;
    case 'wait_for_navigation': return `Wait for navigation to \`${step.url_pattern}\``;
    case 'wait_for_request': return `Wait for API call to \`${step.url_pattern}\``;
    case 'keypress': return `Press \`${step.key}\``;
    case 'scroll': return step.selector ? `Scroll to \`${step.selector}\`` : `Scroll ${step.direction ?? 'down'}`;
    case 'wait': return `Wait ${step.duration}ms`;
    default: return `Perform ${(step as ScenarioStep).action}`;
  }
}
