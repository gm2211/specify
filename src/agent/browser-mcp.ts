/**
 * src/agent/browser-mcp.ts — In-process MCP server wrapping Playwright Page
 *
 * Exposes browser interaction tools to the Agent SDK via createSdkMcpServer.
 * All tools are prefixed `browser_` and delegate to executeCommand from
 * capture-agent.ts, which handles Playwright actions + auto-screenshots.
 *
 * Also exposes `ask_user` — the agent's channel to request credentials,
 * choices, or any input from the human operator. Supports a pluggable
 * handler for chat mode / WebSocket / external agent integration.
 */

import * as readline from 'readline';
import type { Page } from 'playwright';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { executeCommand } from '../cli/commands/capture-agent.js';
import { eventBus } from './event-bus.js';
import type { ObservationRecorder } from './observation.js';
import { isFaultType, type FaultInjector } from './fault-injector.js';
import type { ProbePlan } from './probe-plan.js';

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`\n🔑 ${question}\n> `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function createBrowserMcpServer(
  page: Page,
  screenshotFn: (name: string) => Promise<string>,
  serverName: string = 'browser',
  askUserHandler?: (question: string) => Promise<string>,
  recorder?: ObservationRecorder,
  faultInjector?: FaultInjector,
  probePlan?: ProbePlan,
) {
  const handleAskUser = askUserHandler ?? promptUser;

  const server = createSdkMcpServer({
    name: serverName,
    tools: [
      tool(
        'browser_goto',
        'Navigate to a URL',
        { url: z.string(), waitUntil: z.string().optional(), timeout: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'goto', url: args.url, options: { waitUntil: args.waitUntil, timeout: args.timeout } }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_click',
        'Click an element by CSS selector',
        { selector: z.string(), timeout: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'click', selector: args.selector, options: { timeout: args.timeout } }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_fill',
        'Fill an input element by CSS selector',
        { selector: z.string(), value: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'fill', selector: args.selector, value: args.value }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_type',
        'Type text character by character into an element',
        { selector: z.string(), text: z.string(), delay: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'type', selector: args.selector, text: args.text, options: { delay: args.delay } }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_select',
        'Select an option from a dropdown by CSS selector',
        { selector: z.string(), value: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'selectOption', selector: args.selector, value: args.value }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_hover',
        'Hover over an element by CSS selector',
        { selector: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'hover', selector: args.selector }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_press',
        'Press a key on an element by CSS selector',
        { selector: z.string(), key: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'press', selector: args.selector, key: args.key }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_screenshot',
        'Take a manual screenshot with an optional name',
        { name: z.string().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'screenshot', name: args.name }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_content',
        'Get the current page HTML content',
        {},
        async () => {
          const result = await executeCommand(page, { action: 'content' }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_evaluate',
        'Execute JavaScript in the page context',
        { expression: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'evaluate', expression: args.expression }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_url',
        'Get the current page URL',
        {},
        async () => {
          const result = await executeCommand(page, { action: 'url' }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_title',
        'Get the current page title',
        {},
        async () => {
          const result = await executeCommand(page, { action: 'title' }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_wait_for',
        'Wait for a CSS selector to appear on the page',
        { selector: z.string(), state: z.string().optional(), timeout: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'waitForSelector', selector: args.selector, options: { state: args.state, timeout: args.timeout } }, screenshotFn, recorder, probePlan);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      // browser_inject_fault / browser_clear_faults are only registered when
      // a FaultInjector was wired in (i.e. SPECIFY_ENABLE_FAULT_INJECTION is
      // on and a fault plan is active for this run). Omitting them entirely
      // when disabled — rather than registering no-op versions — keeps the
      // tool set (and therefore agent behavior) unchanged when the feature
      // is off.
      ...(faultInjector
        ? [
            tool(
              'browser_inject_fault',
              "Scope a seeded fault to matching requests for the rest of this session (until cleared). Use it to deliberately break one endpoint (e.g. urlPattern '/api/orders', fault '500') so you can verify the app's degraded-mode behavior, then call browser_clear_faults when you're done with that behavior. Faults are applied before the request reaches the real server — the target never sees the faulted request.",
              {
                urlPattern: z.string().describe("Substring or '*'-wildcard pattern matched against the full request URL"),
                fault: z.enum(['500', 'timeout', 'abort', 'empty']).describe('500 = fulfilled with a 500 error body; timeout = delayed abort; abort = immediate connection abort; empty = 200 with an empty body'),
                method: z.string().optional().describe('Restrict to one HTTP method, e.g. "POST" (default: any method)'),
                rate: z.number().min(0).max(1).optional().describe('Fire probability, 0.0-1.0 (default: 1.0 — always fire when matched)'),
              },
              async (args) => {
                if (!isFaultType(args.fault)) {
                  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `unknown fault type: ${args.fault}` }) }] };
                }
                faultInjector.addRule({
                  urlPattern: args.urlPattern,
                  fault: args.fault,
                  method: args.method,
                  rate: args.rate ?? 1.0,
                });
                return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, activeRules: faultInjector.getPlan().rules.length }) }] };
              },
            ),
            tool(
              'browser_clear_faults',
              'Clear all currently active injected faults. Call this after finishing verification of an error-handling behavior, so subsequent requests (for other behaviors) are not faulted.',
              {},
              async () => {
                faultInjector.clear();
                return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
              },
            ),
          ]
        : []),
      tool(
        'ask_user',
        'Ask the human operator a question. Use this when you need credentials (username, password, API key), must choose between ambiguous options, or need any information you cannot discover autonomously. The user sees the question on stderr and types a response.',
        { question: z.string().describe('The question to ask the human operator') },
        async (args) => {
          eventBus.send('agent:ask_user', { question: args.question });
          const answer = await handleAskUser(args.question);
          eventBus.send('user:answer', { question: args.question });
          return { content: [{ type: 'text' as const, text: answer }] };
        },
      ),
    ],
  });

  return server;
}
