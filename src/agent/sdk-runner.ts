/**
 * src/agent/sdk-runner.ts — Core runner for Agent SDK integration
 *
 * Launches Playwright + CaptureCollector for web targets, then drives
 * Claude via the Agent SDK query() function with browser MCP tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options, JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';

export interface SdkRunnerOptions {
  task: 'capture' | 'verify' | 'replay' | 'compare' | 'augment';
  systemPrompt: string;
  userPrompt: string;
  url?: string;
  remoteUrl?: string;
  localUrl?: string;
  spec?: string;
  captureDir?: string;
  outputDir: string;
  cwd?: string;
  specOutput?: string;
  specName?: string;
  headed?: boolean;
}

export interface SdkRunnerResult {
  result: string;
  costUsd: number;
  structuredOutput?: unknown;
}

/** Error thrown when the Agent SDK returns a non-success result. */
export class AgentError extends Error {
  constructor(
    public readonly subtype: string,
    public readonly costUsd: number,
  ) {
    super(`Agent ended with ${subtype}`);
    this.name = 'AgentError';
  }
}

/** Type-safe extraction of a boolean field from structured output. */
export function extractBool(output: unknown, field: string): boolean | null {
  if (output && typeof output === 'object' && field in output) {
    const val = (output as Record<string, unknown>)[field];
    return typeof val === 'boolean' ? val : null;
  }
  return null;
}

interface BrowserSession {
  browser: import('playwright').Browser;
  collector: import('./capture.js').CaptureCollector;
  page: import('playwright').Page;
  mcpServer: McpServerConfig;
}

async function launchBrowserSession(
  url: string,
  captureOutputDir: string,
  headed: boolean,
  serverName: string,
): Promise<BrowserSession> {
  const { chromium } = await import('playwright');
  const { CaptureCollector } = await import('./capture.js');
  const { createBrowserMcpServer } = await import('./browser-mcp.js');

  const parsedUrl = new URL(url);
  const contextOptions: Record<string, unknown> = {
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  };
  let navigateUrl = url;
  if (parsedUrl.username) {
    contextOptions.httpCredentials = {
      username: decodeURIComponent(parsedUrl.username),
      password: decodeURIComponent(parsedUrl.password),
    };
    parsedUrl.username = '';
    parsedUrl.password = '';
    navigateUrl = parsedUrl.toString();
  }

  const collector = new CaptureCollector({
    outputDir: captureOutputDir,
    targetUrl: url,
    hostFilter: new URL(url).hostname,
  });

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext(contextOptions as Parameters<typeof browser.newContext>[0]);
  await collector.attachToContext(context);
  const page = await context.newPage();
  collector.attachToPage(page);

  await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await collector.screenshot(page, 'initial');

  const mcpServer = createBrowserMcpServer(page, (name: string) => collector.screenshot(page, name), serverName);

  return { browser, collector, page, mcpServer };
}

function browserToolNames(serverName: string): string[] {
  return [
    `mcp__${serverName}__browser_goto`, `mcp__${serverName}__browser_click`,
    `mcp__${serverName}__browser_fill`, `mcp__${serverName}__browser_type`,
    `mcp__${serverName}__browser_select`, `mcp__${serverName}__browser_hover`,
    `mcp__${serverName}__browser_press`, `mcp__${serverName}__browser_screenshot`,
    `mcp__${serverName}__browser_content`, `mcp__${serverName}__browser_evaluate`,
    `mcp__${serverName}__browser_url`, `mcp__${serverName}__browser_title`,
    `mcp__${serverName}__browser_wait_for`, `mcp__${serverName}__ask_user`,
  ];
}

function getOutputFormat(task: string): JsonSchemaOutputFormat | undefined {
  if (task === 'verify') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          pass: { type: 'boolean', description: 'True only if ALL behaviors pass' },
          summary: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              passed: { type: 'number' },
              failed: { type: 'number' },
              skipped: { type: 'number' },
            },
            required: ['total', 'passed', 'failed', 'skipped'],
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Fully-qualified: area-id/behavior-id' },
                description: { type: 'string' },
                status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
                method: { type: 'string', description: 'How the behavior was verified' },
                evidence: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['screenshot', 'text', 'network_log', 'command_output', 'file'] },
                      label: { type: 'string' },
                      content: { type: 'string' },
                    },
                    required: ['type', 'label', 'content'],
                  },
                },
                rationale: { type: 'string' },
                duration_ms: { type: 'number' },
              },
              required: ['id', 'description', 'status'],
            },
          },
        },
        required: ['pass', 'summary', 'results'],
      },
    };
  }
  if (task === 'compare') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          match: { type: 'boolean', description: 'True only if no meaningful differences found' },
          summary: { type: 'string', description: 'One-line summary' },
          diffs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'string', description: 'Page path or identifier' },
                description: { type: 'string', description: 'What differs' },
                remote: { type: 'string', description: 'Remote behavior' },
                local: { type: 'string', description: 'Local behavior' },
                severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic'] },
              },
              required: ['page', 'description', 'remote', 'local', 'severity'],
            },
          },
        },
        required: ['match', 'summary', 'diffs'],
      },
    };
  }
  if (task === 'augment') {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          synthetic_traffic: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                method: { type: 'string' },
                status: { type: 'number' },
                contentType: { type: 'string' },
                responseBody: { type: 'string' },
              },
              required: ['url', 'method', 'status', 'contentType', 'responseBody'],
            },
          },
        },
        required: ['synthetic_traffic'],
      },
    };
  }
  return undefined;
}

export async function runSpecifyAgent(opts: SdkRunnerOptions): Promise<SdkRunnerResult> {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  const sessions: BrowserSession[] = [];
  const mcpServers: Record<string, McpServerConfig> = {};
  const allowedBrowserTools: string[] = [];

  try {
    if (opts.task === 'compare') {
      // Dual browser sessions for compare
      if (!opts.remoteUrl || !opts.localUrl) {
        throw new Error('compare task requires both remoteUrl and localUrl');
      }
      // Launch sequentially so a failure in the second doesn't leak the first.
      // The first session is pushed to sessions[] immediately, so the finally
      // block cleans it up if the second launch throws.
      const remoteSession = await launchBrowserSession(opts.remoteUrl, path.join(opts.outputDir, 'remote'), !!opts.headed, 'remote');
      sessions.push(remoteSession);
      const localSession = await launchBrowserSession(opts.localUrl, path.join(opts.outputDir, 'local'), !!opts.headed, 'local');
      sessions.push(localSession);
      mcpServers.remote = remoteSession.mcpServer;
      mcpServers.local = localSession.mcpServer;
      allowedBrowserTools.push(...browserToolNames('remote'), ...browserToolNames('local'));
    } else if (opts.url) {
      // Single browser session for capture/verify/replay
      const session = await launchBrowserSession(
        opts.url,
        path.join(opts.outputDir, 'capture'),
        !!opts.headed,
        'browser',
      );
      sessions.push(session);
      mcpServers.browser = session.mcpServer;
      allowedBrowserTools.push(...browserToolNames('browser'));
    }

    let finalResult = '';
    let costUsd = 0;
    let structuredOutput: unknown | undefined;

    const outputFormat = getOutputFormat(opts.task);

    // Sandbox: web-target sessions only get the tools they need.
    // Bash, Edit, Glob, Grep are excluded to prevent prompt injection
    // from target pages reaching the local filesystem or shell.
    const fileTools: string[] = ['Read'];
    if (opts.task === 'capture' || opts.task === 'compare') {
      fileTools.push('Write');
    }

    const queryOptions: Options = {
      systemPrompt: opts.systemPrompt,
      mcpServers,
      allowedTools: [
        ...fileTools,
        ...allowedBrowserTools,
      ],
      cwd: opts.cwd ?? process.cwd(),
      maxTurns: 200,
      persistSession: false,
      ...(outputFormat ? { outputFormat } : {}),
    };

    for await (const message of query({
      prompt: opts.userPrompt,
      options: queryOptions,
    })) {
      if (message.type === 'assistant') {
        const textBlocks = message.message.content.filter((b: { type: string }) => b.type === 'text');
        for (const block of textBlocks) {
          process.stderr.write((block as { type: 'text'; text: string }).text + '\n');
        }
        process.stderr.write('\n');
      } else if (message.type === 'tool_use_summary') {
        const summary = (message as { summary: string }).summary;
        process.stderr.write(`  \x1b[2m${summary}\x1b[0m\n`);
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalResult = message.result;
          costUsd = message.total_cost_usd;
          structuredOutput = message.structured_output;
        } else {
          costUsd = message.total_cost_usd;
          throw new AgentError(message.subtype, costUsd);
        }
      }
    }

    return { result: finalResult, costUsd, structuredOutput };
  } finally {
    for (const session of sessions) {
      session.collector.save();
      await session.browser.close().catch(() => {});
    }
  }
}
