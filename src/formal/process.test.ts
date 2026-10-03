import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runProcess } from './process.js';

test('runs a child directly and captures both output streams', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
    {
      cwd: process.cwd(),
      timeoutMs: 2_000,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
  assert.equal(result.unavailable, false);
});

test('reports an unavailable executable without throwing', async () => {
  const result = await runProcess('specify-no-such-formal-tool', [], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
  });
  assert.equal(result.unavailable, true);
  assert.equal(result.exitCode, null);
  assert.match(result.message ?? '', /ENOENT/);
});

test('times out and reaps a child that ignores graceful termination', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    {
      cwd: process.cwd(),
      timeoutMs: 100,
    },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.match(result.message ?? '', /exceeded 100ms/);
});

test('terminates a child when combined captured output exceeds the bound', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(1024 * 1024 + 1))'],
    {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    },
  );
  assert.equal(result.outputLimit, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024 * 1024);
});

test('forwards interruption only after cleaning up the active process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'specify-process-signal-'));
  const ready = join(directory, 'ready');
  const stopped = join(directory, 'stopped');
  const processModule = pathToFileURL(fileURLToPath(new URL('./process.js', import.meta.url))).href;
  const descendant = `const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const wrapper = `import { runProcess } from ${JSON.stringify(processModule)}; await runProcess(process.execPath, ['-e', ${JSON.stringify(descendant)}], { cwd: process.cwd(), timeoutMs: 20000 });`;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
      stdio: 'ignore',
    });
    await waitForFile(ready);
    child.kill('SIGTERM');
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    assert.equal(result.signal, 'SIGTERM');
    await waitForFile(stopped);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
