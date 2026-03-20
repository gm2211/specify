/**
 * src/agent/sdk-runner.ts — Core runner for Agent SDK integration
 *
 * Launches Playwright + CaptureCollector for web targets, then drives
 * Claude via the Agent SDK query() function with browser MCP tools.
 */

import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export interface SdkRunnerOptions {
  task: 'capture' | 'verify' | 'replay';
  systemPrompt: string;
  userPrompt: string;
  url?: string;
  spec?: string;
  captureDir?: string;
  outputDir: string;
  headed?: boolean;
}

export async function runSpecifyAgent(opts: SdkRunnerOptions): Promise<{ result: string; costUsd: number }> {
  const isWebTarget = !!opts.url;

  let browser: import('playwright').Browser | undefined;
  let collector: import('./capture.js').CaptureCollector | undefined;
  let browserMcpServer: McpServerConfig | undefined;
  let page: import('playwright').Page | undefined;

  if (isWebTarget) {
    const { chromium } = await import('playwright');
    const { CaptureCollector } = await import('./capture.js');
    const { createBrowserMcpServer } = await import('./browser-mcp.js');

    const parsedUrl = new URL(opts.url!);
    const contextOptions: Record<string, unknown> = {
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    };
    let navigateUrl = opts.url!;
    if (parsedUrl.username) {
      contextOptions.httpCredentials = {
        username: decodeURIComponent(parsedUrl.username),
        password: decodeURIComponent(parsedUrl.password),
      };
      parsedUrl.username = '';
      parsedUrl.password = '';
      navigateUrl = parsedUrl.toString();
    }

    collector = new CaptureCollector({
      outputDir: path.join(opts.outputDir, 'capture'),
      targetUrl: opts.url!,
      hostFilter: new URL(opts.url!).hostname,
    });

    browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext(contextOptions as Parameters<typeof browser.newContext>[0]);
    await collector.attachToContext(context);
    const p = await context.newPage();
    page = p;
    collector.attachToPage(p);

    await p.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await collector.screenshot(p, 'initial');

    browserMcpServer = createBrowserMcpServer(p, (name: string) => collector!.screenshot(p, name));
  }

  let finalResult = '';
  let costUsd = 0;

  const mcpServers: Record<string, McpServerConfig> = {};
  if (isWebTarget && browserMcpServer) {
    mcpServers.browser = browserMcpServer;
  }

  const browserTools = [
    'mcp__browser__browser_goto', 'mcp__browser__browser_click',
    'mcp__browser__browser_fill', 'mcp__browser__browser_type',
    'mcp__browser__browser_select', 'mcp__browser__browser_hover',
    'mcp__browser__browser_press', 'mcp__browser__browser_screenshot',
    'mcp__browser__browser_content', 'mcp__browser__browser_evaluate',
    'mcp__browser__browser_url', 'mcp__browser__browser_title',
    'mcp__browser__browser_wait_for', 'mcp__browser__ask_user',
  ];

  try {
    for await (const message of query({
      prompt: opts.userPrompt,
      options: {
        systemPrompt: opts.systemPrompt,
        mcpServers,
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          ...(isWebTarget ? browserTools : []),
        ],
        cwd: opts.outputDir,
        maxTurns: 200,
        persistSession: false,
      },
    })) {
      if (message.type === 'assistant') {
        const textBlocks = message.message.content.filter((b: { type: string }) => b.type === 'text');
        for (const block of textBlocks) {
          process.stderr.write((block as { type: 'text'; text: string }).text + '\n');
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalResult = message.result;
          costUsd = message.total_cost_usd;
        }
      }
    }
  } finally {
    if (collector) {
      collector.save();
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return { result: finalResult, costUsd };
}
