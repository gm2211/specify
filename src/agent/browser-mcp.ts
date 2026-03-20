/**
 * src/agent/browser-mcp.ts — In-process MCP server wrapping Playwright Page
 *
 * Exposes browser interaction tools to the Agent SDK via createSdkMcpServer.
 * All tools are prefixed `browser_` and delegate to executeCommand from
 * capture-agent.ts, which handles Playwright actions + auto-screenshots.
 *
 * Also exposes `ask_user` — the agent's channel to request credentials,
 * choices, or any input from the human operator.
 */

import * as readline from 'readline';
import type { Page } from 'playwright';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { executeCommand } from '../cli/commands/capture-agent.js';

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
) {
  const server = createSdkMcpServer({
    name: 'browser',
    tools: [
      tool(
        'browser_goto',
        'Navigate to a URL',
        { url: z.string(), waitUntil: z.string().optional(), timeout: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'goto', url: args.url, options: { waitUntil: args.waitUntil, timeout: args.timeout } }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_click',
        'Click an element by CSS selector',
        { selector: z.string(), timeout: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'click', selector: args.selector, options: { timeout: args.timeout } }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_fill',
        'Fill an input element by CSS selector',
        { selector: z.string(), value: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'fill', selector: args.selector, value: args.value }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_type',
        'Type text character by character into an element',
        { selector: z.string(), text: z.string(), delay: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'type', selector: args.selector, text: args.text, options: { delay: args.delay } }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_select',
        'Select an option from a dropdown by CSS selector',
        { selector: z.string(), value: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'selectOption', selector: args.selector, value: args.value }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_hover',
        'Hover over an element by CSS selector',
        { selector: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'hover', selector: args.selector }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_press',
        'Press a key on an element by CSS selector',
        { selector: z.string(), key: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'press', selector: args.selector, key: args.key }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_screenshot',
        'Take a manual screenshot with an optional name',
        { name: z.string().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'screenshot', name: args.name }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_content',
        'Get the current page HTML content',
        {},
        async () => {
          const result = await executeCommand(page, { action: 'content' }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_evaluate',
        'Execute JavaScript in the page context',
        { expression: z.string() },
        async (args) => {
          const result = await executeCommand(page, { action: 'evaluate', expression: args.expression }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_url',
        'Get the current page URL',
        {},
        async () => {
          const result = await executeCommand(page, { action: 'url' }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_title',
        'Get the current page title',
        {},
        async () => {
          const result = await executeCommand(page, { action: 'title' }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'browser_wait_for',
        'Wait for a CSS selector to appear on the page',
        { selector: z.string(), state: z.string().optional(), timeout: z.number().optional() },
        async (args) => {
          const result = await executeCommand(page, { action: 'waitForSelector', selector: args.selector, options: { state: args.state, timeout: args.timeout } }, screenshotFn);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'ask_user',
        'Ask the human operator a question. Use this when you need credentials (username, password, API key), must choose between ambiguous options, or need any information you cannot discover autonomously. The user sees the question on stderr and types a response.',
        { question: z.string().describe('The question to ask the human operator') },
        async (args) => {
          const answer = await promptUser(args.question);
          return { content: [{ type: 'text' as const, text: answer }] };
        },
      ),
    ],
  });

  return server;
}
