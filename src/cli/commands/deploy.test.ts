import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { deployCommand, _internals } from './deploy.js';

class Sink extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

test('describe: emits valid JSON manifest with required fields', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'describe', format: 'json', versionOverride: '1.2.3', out });
  assert.equal(code, 0);
  const m = JSON.parse(out.buf);
  assert.equal(m.version, '1.2.3');
  assert.match(m.image.registry, /ghcr\.io\/.*specify-qa/);
  assert.match(m.terraform_module.source, /\/\/deploy\/terraform\/modules\/specify-qa$/);
  assert.ok(Array.isArray(m.required_inputs));
  assert.ok(m.required_inputs.some((r: { name: string }) => r.name === 'anthropic_api_key_secret'));
  assert.ok(m.oneof_groups.some((g: { name: string }) => g.name === 'target'));
  assert.ok(m.oneof_groups.some((g: { name: string }) => g.name === 'spec'));
  assert.ok(m.outputs.includes('inbox_url'));
  assert.ok(m.examples.length >= 2);
});

test('describe: text format renders human summary', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'describe', format: 'text', versionOverride: '0.9.0', out });
  assert.equal(code, 0);
  assert.match(out.buf, /specify-qa v0\.9\.0/);
  assert.match(out.buf, /Required inputs/);
  assert.match(out.buf, /Pick-one groups/);
});

test('print-tf: minimal preset emits valid HCL skeleton', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'print-tf', preset: 'minimal', out });
  assert.equal(code, 0);
  assert.match(out.buf, /module "specify_qa"/);
  assert.match(out.buf, /target_url\s*=/);
  assert.match(out.buf, /spec_inline\s*=\s*file/);
});

test('print-tf: watch-mode preset includes discovery block', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'print-tf', preset: 'watch-mode', out });
  assert.equal(code, 0);
  assert.match(out.buf, /discovery = \{/);
  assert.match(out.buf, /mode\s*=\s*"watch"/);
});

test('print-tf: gitops-spec preset uses spec_git', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'print-tf', preset: 'gitops-spec', out });
  assert.equal(code, 0);
  assert.match(out.buf, /spec_git = \{/);
  assert.match(out.buf, /deploy_key_secret/);
});

test('print-tf: unknown preset returns parse error + supported list', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'print-tf', preset: 'no-such', out });
  assert.notEqual(code, 0);
  const err = JSON.parse(out.buf);
  assert.equal(err.error, 'unknown_preset');
  assert.ok(err.supported.includes('minimal'));
});

test('unknown verb is reported with structured error', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'frobnicate', out });
  assert.notEqual(code, 0);
  const err = JSON.parse(out.buf);
  assert.equal(err.error, 'unknown_verb');
  assert.deepEqual(err.supported, ['describe', 'print-tf']);
});

test('manifest covers every printed preset', () => {
  const m = _internals.buildManifest('test');
  for (const ex of m.examples) {
    assert.ok(_internals.TF_PRESETS[ex.name], `missing preset for example ${ex.name}`);
  }
});
