// Regenerate the README image from the real UI and an isolated current self-spec.
// Requires: npm --prefix webapp run build && npx playwright install chromium
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-readme-'));
fs.cpSync(path.join(root, 'specify.spec'), path.join(temporary, 'spec'), {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes('.specify'),
});
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const env = {
  ...process.env,
  SPECIFY_ENABLE_LEARNED_SKILLS: 'false',
  SPECIFY_ENABLE_FORMULA_REVIEW: 'false',
};
const child = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    'src/cli/index.ts',
    'review',
    '--spec',
    path.join(temporary, 'spec'),
    '--port',
    String(port),
    '--no-open',
  ],
  { cwd: root, env, stdio: 'pipe' },
);
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk;
});
child.stderr.on('data', (chunk) => {
  logs += chunk;
});
let browser;
try {
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url + '/api/spec');
      if (response.ok) break;
    } catch {
      /* startup */
    }
    if (attempt >= 40 || child.exitCode !== null)
      throw new Error(`Review server did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1,
  });
  await page.goto(url);
  await page.getByRole('heading', { name: 'Specify CLI', exact: true }).waitFor();
  await page.getByText('Candidate spec discovery', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(root, 'assets/screenshots/review-overview.png') });
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', resolve);
  });
  fs.rmSync(temporary, { recursive: true, force: true });
}
