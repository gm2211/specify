import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createCliMcpServer, binaryAllowed, cliToolNames } from './cli-mcp.js';
import { CliObservationRecorder } from './observation.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mcp-test-'));
}

function findHandler(
  server: ReturnType<typeof createCliMcpServer>,
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const anyServer = server as unknown as {
    instance?: { _registeredTools?: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> };
  };
  const tools = anyServer.instance?._registeredTools ?? {};
  const t = tools[name];
  if (!t) throw new Error(`tool ${name} not found on server (have: ${Object.keys(tools).join(', ')})`);
  return t.handler;
}

test('cliToolNames returns the namespaced cli_run tool', () => {
  assert.deepEqual(cliToolNames('cli'), ['mcp__cli__cli_run']);
});

test('binaryAllowed: exact match is always allowed', () => {
  assert.equal(binaryAllowed('mycli', 'mycli', '/work'), true);
});

test('binaryAllowed: mismatch is rejected unless SPECIFY_CLI_ALLOW_ANY_BINARY is set', () => {
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  assert.equal(binaryAllowed('other', 'mycli', '/work'), false);
  process.env.SPECIFY_CLI_ALLOW_ANY_BINARY = '1';
  assert.equal(binaryAllowed('other', 'mycli', '/work'), true);
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
});

test('binaryAllowed: ./variant and absolute path resolve to the same file as the spec binary', () => {
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  // Spec declares "./mycli", agent passes equivalent path forms.
  assert.equal(binaryAllowed('./mycli', './mycli', '/work'), true);
  assert.equal(binaryAllowed('mycli', './mycli', '/work'), true, 'bare relative form resolves to the same file');
  assert.equal(binaryAllowed('/work/mycli', './mycli', '/work'), true, 'absolute path to the same file matches');
  // Spec declares an absolute path, agent passes relative forms.
  assert.equal(binaryAllowed('./mycli', '/work/mycli', '/work'), true);
  assert.equal(binaryAllowed('/work/mycli', '/work/mycli', '/work'), true);
});

test('binaryAllowed: bare spec name means "this program" — basename match from any path', () => {
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  assert.equal(binaryAllowed('git', 'git', '/work'), true);
  assert.equal(binaryAllowed('./git', 'git', '/work'), true);
  assert.equal(binaryAllowed('/usr/bin/git', 'git', '/work'), true);
});

test('binaryAllowed: genuinely different binaries are still rejected under normalization', () => {
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  assert.equal(binaryAllowed('/usr/bin/rm', 'git', '/work'), false);
  assert.equal(binaryAllowed('./othercli', './mycli', '/work'), false);
  assert.equal(binaryAllowed('/elsewhere/mycli', './mycli', '/work'), false, 'basename fallback does not apply when the spec binary is a path');
  assert.equal(binaryAllowed('gitx', 'git', '/work'), false);
});

test('cli_run: executes argv[0] === binary via node, records exit code and output', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({ binary: process.execPath, recorder, serverName: 'cli' });
  const handler = findHandler(server, 'cli_run');

  const res = await handler({ argv: [process.execPath, '-e', 'console.log("hello"); process.exitCode = 0;'] });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.exitCode, 0);
  assert.match(parsed.stdout, /hello/);
  assert.equal(res.isError, undefined);

  const steps = recorder.getSteps();
  assert.equal(steps.length, 1);
  assert.equal(steps[0].exitCode, 0);
  assert.equal(steps[0].argv[0], process.execPath);
});

test('cli_run: nonzero exit code is recorded, not thrown', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({ binary: process.execPath, recorder });
  const handler = findHandler(server, 'cli_run');

  const res = await handler({ argv: [process.execPath, '-e', 'process.exitCode = 7;'] });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.exitCode, 7);

  const steps = recorder.getSteps();
  assert.equal(steps[0].exitCode, 7);
});

test('cli_run: stdin is piped to the process and recorded (length-capped)', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({ binary: process.execPath, recorder });
  const handler = findHandler(server, 'cli_run');

  const script = 'let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => { console.log(d.trim()); });';
  const res = await handler({ argv: [process.execPath, '-e', script], stdin: 'ping' });
  const parsed = JSON.parse(res.content[0].text);
  assert.match(parsed.stdout, /ping/);

  const steps = recorder.getSteps();
  assert.equal(steps[0].stdin, 'ping');
  assert.equal(steps[0].stdinTruncated, undefined);
});

test('cli_run: rejects argv[0] that does not match the spec binary, and records the rejection', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  const server = createCliMcpServer({ binary: 'mycli', recorder });
  const handler = findHandler(server, 'cli_run');

  const res = await handler({ argv: ['rm', '-rf', '/'] });
  assert.equal(res.isError, true);
  const parsed = JSON.parse(res.content[0].text);
  assert.match(parsed.error, /does not match the spec's target binary/);

  const steps = recorder.getSteps();
  assert.equal(steps.length, 1);
  assert.match(steps[0].error ?? '', /does not match/);
  assert.equal(steps[0].exitCode, null);
});

test('cli_run: SPECIFY_CLI_ALLOW_ANY_BINARY=1 lifts the binary restriction', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  process.env.SPECIFY_CLI_ALLOW_ANY_BINARY = '1';
  try {
    const server = createCliMcpServer({ binary: 'mycli', recorder });
    const handler = findHandler(server, 'cli_run');

    const res = await handler({ argv: [process.execPath, '-e', 'process.exitCode = 0;'] });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.equal(parsed.exitCode, 0);
  } finally {
    delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  }
});

test('cli_run: output beyond the cap is truncated during streaming, stored size stays bounded', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({ binary: process.execPath, recorder });
  const handler = findHandler(server, 'cli_run');

  // Emit ~4 MiB across many chunks — far beyond the 256 KiB cap. The cap is
  // enforced as chunks arrive (BoundedSink), so the stored size must be
  // exactly the cap regardless of how much the process printed, and the exit
  // code must still be collected normally after truncation kicks in.
  const script = 'for (let i = 0; i < 64; i++) process.stdout.write("x".repeat(64 * 1024)); process.exitCode = 3;';
  const res = await handler({ argv: [process.execPath, '-e', script] });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.stdoutTruncated, true);
  assert.equal(parsed.stdout.length, 256 * 1024, 'stored stdout is capped at exactly 256 KiB');
  assert.equal(parsed.exitCode, 3, 'exit code is still collected after truncation');

  const steps = recorder.getSteps();
  assert.equal(steps[0].stdoutTruncated, true);
  assert.equal(steps[0].stdout.length, 256 * 1024);
  assert.equal(steps[0].exitCode, 3);
});

test('cli_run: stderr is capped during streaming independently of stdout', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({ binary: process.execPath, recorder });
  const handler = findHandler(server, 'cli_run');

  const script = 'process.stdout.write("small"); for (let i = 0; i < 8; i++) process.stderr.write("e".repeat(64 * 1024));';
  const res = await handler({ argv: [process.execPath, '-e', script] });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.stdoutTruncated, false);
  assert.equal(parsed.stdout, 'small');
  assert.equal(parsed.stderrTruncated, true);
  assert.equal(parsed.stderr.length, 256 * 1024);
});

test('cli_run: accepts ./variant and absolute-path forms of the spec binary', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  delete process.env.SPECIFY_CLI_ALLOW_ANY_BINARY;
  // Spec declares the absolute node path; invoke via a relative path from the
  // session cwd that resolves to the same file.
  const relative = path.relative(process.cwd(), process.execPath);
  const server = createCliMcpServer({ binary: process.execPath, recorder });
  const handler = findHandler(server, 'cli_run');

  const res = await handler({ argv: [relative, '-e', 'process.exitCode = 0;'] });
  assert.equal(res.isError, undefined);
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.exitCode, 0);
});

test('cli_run: timeout kills the process and is recorded', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({ binary: process.execPath, recorder });
  const handler = findHandler(server, 'cli_run');

  const res = await handler({
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000);'],
    timeoutMs: 200,
  });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.exitCode, null);
  assert.match(parsed.error ?? '', /timed out/);

  const steps = recorder.getSteps();
  assert.equal(steps[0].exitCode, null);
  assert.equal(steps[0].signal, 'SIGKILL');
});

test('cli_run: uses spec target.env and target.timeout_ms as defaults', async () => {
  const dir = tmpDir();
  const recorder = new CliObservationRecorder({ outputDir: dir });
  const server = createCliMcpServer({
    binary: process.execPath,
    env: { SPECIFY_TEST_VAR: 'from-spec' },
    recorder,
  });
  const handler = findHandler(server, 'cli_run');

  const res = await handler({ argv: [process.execPath, '-e', 'console.log(process.env.SPECIFY_TEST_VAR);'] });
  const parsed = JSON.parse(res.content[0].text);
  assert.match(parsed.stdout, /from-spec/);
});
