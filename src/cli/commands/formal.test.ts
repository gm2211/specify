import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../index.js', import.meta.url));
const spec = path.resolve('specify.spec');
function invoke(args: string[], enabled: boolean) {
  return spawnSync(process.execPath, [cli, 'verify', '--spec', spec, '--mode', 'formal', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      SPECIFY_ENABLE_QUINT_SPECS: enabled ? '1' : '0',
      SPECIFY_ENABLE_QUINT_SYMBOLIC: enabled ? '1' : '0',
    },
  });
}
test('formal CLI is discoverable but disabled unless opted in', () => {
  const run = invoke([], false);
  assert.equal(run.status, 2);
  assert.match(JSON.parse(run.stdout).error, /SPECIFY_ENABLE_QUINT_SPECS/);
});
test('formal CLI requires an explicit manifest before any checker execution', () => {
  const run = invoke([], true);
  assert.equal(run.status, 2);
  assert.match(JSON.parse(run.stdout).error, /--formal-manifest/);
});
