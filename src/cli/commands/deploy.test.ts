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

test('describe: target_contract documents protocol + egress', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'describe', format: 'json', versionOverride: 't', out });
  assert.equal(code, 0);
  const m = JSON.parse(out.buf);
  assert.deepEqual(m.target_contract.expected_scheme, ['http', 'https']);
  assert.ok(m.target_contract.expected_response_under_ms > 0);
  assert.match(m.target_contract.egress_required, /NetworkPolicy/);
});

test('describe: trigger_models cover watch/webhook/both/none/cron with cron flagged not_implemented', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'describe', format: 'json', versionOverride: 't', out });
  assert.equal(code, 0);
  const m = JSON.parse(out.buf);
  const modes = m.trigger_models.map((t: { mode: string }) => t.mode);
  for (const expected of ['watch', 'webhook', 'both', 'none', 'cron']) {
    assert.ok(modes.includes(expected), `missing trigger mode: ${expected}`);
  }
  const cron = m.trigger_models.find((t: { mode: string }) => t.mode === 'cron');
  assert.equal(cron.status, 'not_implemented');
});

test('describe: text format renders human summary', async () => {
  const out = new Sink();
  const code = await deployCommand({ verb: 'describe', format: 'text', versionOverride: '0.9.0', out });
  assert.equal(code, 0);
  assert.match(out.buf, /specify-qa v0\.9\.0/);
  assert.match(out.buf, /Required inputs/);
  assert.match(out.buf, /Pick-one groups/);
  assert.match(out.buf, /Target contract/);
  assert.match(out.buf, /Trigger models/);
  assert.match(out.buf, /\[not implemented\]/);
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
