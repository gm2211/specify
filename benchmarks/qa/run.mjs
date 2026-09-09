import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { chromium } from 'playwright';
import { startFixture, contract } from './fixture.mjs';
import { score } from './score.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const model = 'claude-opus-4-6';
const maxTurns = 80;
const maxBudgetUsd = 2;
const timeoutMs = 240_000;
const reportRoot = path.resolve(
  process.env.QA_COMPARISON_OUTPUT ?? path.join(repo, '.specify/qa-comparison'),
);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];

async function runOne() {
  const arm = arg('--arm');
  const buggy = arg('--variant') === 'defects';
  const resultPath = arg('--result');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-qa-blind-'));
  const outputDir = path.join(work, 'output');
  fs.mkdirSync(outputDir);
  const fixture = await startFixture(buggy);
  const spec = contract(fixture.url);
  const specText = JSON.stringify(spec, null, 2);
  const specPath = path.join(work, 'app.spec.json');
  fs.writeFileSync(specPath, specText);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const started = Date.now();
  let browser;
  let record;
  // Neither arm receives variant identity, oracle code, or expected verdicts.
  const instruction = `Use Playwright browser tools to test every behavior against ${fixture.url}. Do not inspect application source or files outside ${work}. All necessary test data is in the contract and UI. Reset workspace before each independent check. Work only on this disposable target. Return per-behavior passed, failed, or skipped verdicts with observed evidence; do not infer success from absence of errors.`;
  try {
    let output;
    let costUsd;
    let turns;
    if (arm === 'specify') {
      process.env.SPECIFY_MAX_TURNS = String(maxTurns);
      process.env.SPECIFY_MAX_BUDGET_USD = String(maxBudgetUsd);
      for (const name of Object.keys(process.env))
        if (name.startsWith('SPECIFY_ENABLE_') || name.startsWith('HONCHO_'))
          delete process.env[name];
      const { runSpecifyAgent } = await import('../../src/agent/sdk-runner.ts');
      const { getVerifyPrompt } = await import('../../src/agent/prompts.ts');
      const result = await runSpecifyAgent({
        task: 'verify',
        systemPrompt: getVerifyPrompt(specText),
        userPrompt: instruction,
        url: fixture.url,
        spec: specPath,
        cwd: work,
        outputDir,
        maxRetries: 1,
        contextOverride: { memoryPreamble: '', layeredContext: '', skillsText: '' },
        askUserHandler: async () =>
          'Use the test data described in the contract and UI; otherwise mark the check skipped.',
        abortSignal: abortController.signal,
      });
      output = result.structuredOutput;
      costUsd = result.costUsd;
    } else {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      await page.goto(fixture.url);
      const { createBrowserMcpServer } = await import('../../src/agent/browser-mcp.ts');
      let screenshotId = 0;
      const server = createBrowserMcpServer(
        page,
        async () => {
          const dest = path.join(outputDir, `${++screenshotId}.png`);
          await page.screenshot({ path: dest });
          return dest;
        },
        'browser',
        async () =>
          'Use the test data described in the contract and UI; otherwise mark the check skipped.',
      );
      const messages = [];
      for await (const message of query({
        prompt: instruction + '\nContract:\n' + specText,
        options: {
          model,
          thinking: { type: 'adaptive' },
          systemPrompt:
            'You are a QA engineer. Test the supplied acceptance requirements using Playwright and report observed failures and passing checks. Write reusable Playwright tests in the output directory after checking behaviors.',
          cwd: work,
          settingSources: [],
          persistSession: false,
          maxTurns,
          maxBudgetUsd,
          abortController,
          mcpServers: { browser: server },
          allowedTools: ['Read', 'Write', 'mcp__browser__*'],
          disallowedTools: ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                pass: { type: 'boolean' },
                summary: {
                  type: 'object',
                  properties: Object.fromEntries(
                    ['total', 'passed', 'failed', 'skipped'].map((k) => [k, { type: 'number' }]),
                  ),
                  required: ['total', 'passed', 'failed', 'skipped'],
                },
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      description: { type: 'string' },
                      status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
                      method: { type: 'string' },
                      rationale: { type: 'string' },
                      evidence: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            type: { type: 'string' },
                            label: { type: 'string' },
                            content: { type: 'string' },
                          },
                          required: ['type', 'label', 'content'],
                        },
                      },
                    },
                    required: ['id', 'description', 'status'],
                  },
                },
                test_files: { type: 'array', items: { type: 'string' } },
              },
              required: ['pass', 'summary', 'results', 'test_files'],
            },
          },
        },
      })) {
        messages.push(message);
        if (message.type === 'result') {
          costUsd = message.total_cost_usd;
          turns = message.num_turns;
          if (message.subtype !== 'success')
            throw new Error(`${message.subtype}: ${(message.errors ?? []).join('; ')}`);
          output = message.structured_output;
        }
      }
      fs.writeFileSync(
        path.join(outputDir, 'sdk-messages.json'),
        JSON.stringify(messages, null, 2),
      );
    }
    if (!output) throw new Error('No structured output returned');
    record = {
      status: 'completed',
      arm,
      variant: buggy ? 'defects' : 'healthy',
      costUsd,
      turns,
      elapsedMs: Date.now() - started,
      output,
      score: score(output, buggy),
      artifactDir: work,
    };
  } catch (error) {
    record = {
      status: 'error',
      arm,
      variant: buggy ? 'defects' : 'healthy',
      elapsedMs: Date.now() - started,
      error: String(error),
      artifactDir: work,
    };
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close();
    await fixture.close();
  }
  fs.writeFileSync(resultPath, JSON.stringify(record, null, 2));
  if (record.status === 'error') process.exitCode = 1;
}

if (process.argv.includes('--arm')) {
  await runOne();
} else {
  fs.mkdirSync(reportRoot, { recursive: true });
  const runs = [];
  const protocol = {
    model,
    maxTurns,
    maxBudgetUsd,
    timeoutMs,
    repetitions: 3,
    variants: ['healthy', 'defects'],
    arms: ['baseline', 'specify'],
    maximumBudgetUsd: 24,
    note: 'Controlled cold-start ablation sharing browser transport. Not a comparison against every vanilla-agent setup. Failed runs are not bug-detection scores.',
  };
  fs.writeFileSync(path.join(reportRoot, 'protocol.json'), JSON.stringify(protocol, null, 2));
  outer: for (let repeat = 0; repeat < 3; repeat++) {
    for (const variant of repeat % 2 ? ['defects', 'healthy'] : ['healthy', 'defects']) {
      for (const arm of repeat % 2 ? ['specify', 'baseline'] : ['baseline', 'specify']) {
        const filename = `${repeat + 1}-${variant}-${arm}.json`;
        const resultPath = path.join(reportRoot, filename);
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(import.meta.url),
            '--arm',
            arm,
            '--variant',
            variant,
            '--result',
            resultPath,
          ],
          { cwd: repo, timeout: timeoutMs + 30_000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
        );
        fs.writeFileSync(
          path.join(reportRoot, filename + '.log'),
          (child.stdout ?? '') + (child.stderr ?? ''),
        );
        const result = fs.existsSync(resultPath)
          ? JSON.parse(fs.readFileSync(resultPath, 'utf8'))
          : {
              status: 'error',
              arm,
              variant,
              error: String(child.error ?? `process exit ${child.status}`),
            };
        runs.push({ repeat: repeat + 1, ...result });
        fs.writeFileSync(
          path.join(reportRoot, 'results.json'),
          JSON.stringify({ protocol, runs }, null, 2),
        );
        console.log(
          JSON.stringify({
            repeat: repeat + 1,
            arm,
            variant,
            status: result.status,
            score: result.score,
            error: result.error,
          }),
        );
        if (result.status === 'error') break outer;
      }
    }
  }
  if (runs.length !== 12 || runs.some((run) => run.status !== 'completed')) process.exitCode = 1;
}
