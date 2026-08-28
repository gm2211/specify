import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { specContext } from './spec-context.js';
import type { CliContext } from '../types.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-spec-context-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function quietCtx(outputFormat: CliContext['outputFormat'] = 'text'): CliContext {
  return { outputFormat, quiet: true };
}

function fixtureSpecYaml(): string {
  return [
    'version: "2"',
    'name: Demo App',
    'description: A demo app used for spec-context tests.',
    'target:',
    '  type: web',
    '  url: http://localhost:3000',
    'areas:',
    '  - id: capture',
    '    name: Capture',
    '    prose: Capture drives a live browser to record behavior.',
    '    behaviors:',
    '      - id: capture-agent-generates-spec',
    '        description: The capture agent generates a spec from observed behavior.',
    '  - id: ui',
    '    name: User Interface',
    '    prose: The interface favors a light, minimal aesthetic.',
    '    behaviors:',
    '      - id: primary-button-style',
    '        description: The primary action uses the brand accent color.',
    '        tags: [design, ui]',
    '',
  ].join('\n');
}

test('specContext writes PRODUCT.md and DESIGN.md with traceable anchors, no fabrication', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, fixtureSpecYaml());

    const exitCode = await specContext({ spec: specPath, outDir: dir }, quietCtx());
    assert.equal(exitCode, 0);

    const product = fs.readFileSync(path.join(dir, 'PRODUCT.md'), 'utf-8');
    assert.match(product, /<!-- specify:begin:product-context -->/);
    assert.match(product, /<!-- specify:end:product-context -->/);
    assert.match(product, /\[capture\/capture-agent-generates-spec\]/);
    assert.match(product, /\[ui\/primary-button-style\]/);
    assert.match(product, /Capture drives a live browser to record behavior\. \[capture\]/);

    const design = fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf-8');
    assert.match(design, /## Product Constraints \(from spec\)/);
    assert.match(design, /\[ui\/primary-button-style\]/);
    // Only the design-tagged behavior appears — capture's behavior has no design tag.
    assert.doesNotMatch(design, /capture-agent-generates-spec/);
    assert.match(design, /## Visual Tokens \(from code\)/);
    assert.match(design, /No design-token sources found/);
  } finally {
    cleanup();
  }
});

test('specContext regeneration preserves hand-written content outside the managed region', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, fixtureSpecYaml());

    await specContext({ spec: specPath, outDir: dir }, quietCtx());

    const productPath = path.join(dir, 'PRODUCT.md');
    const withHandEdit = fs.readFileSync(productPath, 'utf-8') + '\n## Team Notes\nThis paragraph was added by hand and must survive regeneration.\n';
    fs.writeFileSync(productPath, withHandEdit);

    // Change the spec so the regenerated content actually differs.
    writeFile(specPath, fixtureSpecYaml().replace('The primary action uses the brand accent color.', 'The primary action uses the brand accent color, updated.'));

    const exitCode = await specContext({ spec: specPath, outDir: dir }, quietCtx());
    assert.equal(exitCode, 0);

    const finalContent = fs.readFileSync(productPath, 'utf-8');
    assert.match(finalContent, /## Team Notes/);
    assert.match(finalContent, /This paragraph was added by hand and must survive regeneration\./);
    assert.match(finalContent, /updated\./);
  } finally {
    cleanup();
  }
});

test('specContext refuses to clobber an unmanaged PRODUCT.md and writes a reviewable proposal', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, fixtureSpecYaml());

    const productPath = path.join(dir, 'PRODUCT.md');
    const handAuthored = '# Hand-authored PRODUCT.md\n\nNo specify markers here — predates the feature.\n';
    fs.writeFileSync(productPath, handAuthored);

    const exitCode = await specContext({ spec: specPath, outDir: dir }, quietCtx());
    assert.equal(exitCode, 0);

    // Original left untouched.
    assert.equal(fs.readFileSync(productPath, 'utf-8'), handAuthored);
    // Proposal written alongside it.
    assert.ok(fs.existsSync(path.join(dir, 'PRODUCT.proposed.md')));
    const proposed = fs.readFileSync(path.join(dir, 'PRODUCT.proposed.md'), 'utf-8');
    assert.match(proposed, /\[capture\/capture-agent-generates-spec\]/);
  } finally {
    cleanup();
  }
});

test('specContext --force overwrites an unmanaged file in place', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, fixtureSpecYaml());

    const productPath = path.join(dir, 'PRODUCT.md');
    fs.writeFileSync(productPath, '# Hand-authored, no markers\n');

    const exitCode = await specContext({ spec: specPath, outDir: dir, force: true }, quietCtx());
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, 'PRODUCT.proposed.md')), false);

    const written = fs.readFileSync(productPath, 'utf-8');
    assert.match(written, /\[capture\/capture-agent-generates-spec\]/);
    assert.doesNotMatch(written, /Hand-authored, no markers/);
  } finally {
    cleanup();
  }
});

test('specContext honors --product/--design filename overrides', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, fixtureSpecYaml());

    const exitCode = await specContext({ spec: specPath, outDir: dir, product: 'docs/PRODUCT_CONTEXT.md', design: 'docs/DESIGN_CONTEXT.md' }, quietCtx());
    assert.equal(exitCode, 0);
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'PRODUCT_CONTEXT.md')));
    assert.ok(fs.existsSync(path.join(dir, 'docs', 'DESIGN_CONTEXT.md')));
  } finally {
    cleanup();
  }
});

test('specContext JSON output emits the structured projection with per-file apply status', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeFile(specPath, fixtureSpecYaml());

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string) => { chunks.push(chunk); return true; };
    try {
      const exitCode = await specContext({ spec: specPath, outDir: dir }, quietCtx('json'));
      assert.equal(exitCode, 0);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(chunks.join(''));
    assert.equal(output.spec.name, 'Demo App');
    assert.ok(Array.isArray(output.product.areas));
    const captureArea = output.product.areas.find((a: { areaId: string }) => a.areaId === 'capture');
    assert.equal(captureArea.behaviorClaims[0].anchor, 'capture/capture-agent-generates-spec');
    assert.equal(output.files.product.applied, true);
    assert.equal(output.files.product.created, true);
    assert.equal(output.files.design.applied, true);
  } finally {
    cleanup();
  }
});

test('specContext fails cleanly when --spec cannot be resolved', async () => {
  const exitCode = await specContext({ spec: '' }, quietCtx());
  assert.notEqual(exitCode, 0);
});

test('specContext fails cleanly when the spec file does not exist', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const exitCode = await specContext({ spec: path.join(dir, 'missing.yaml'), outDir: dir }, quietCtx());
    assert.notEqual(exitCode, 0);
  } finally {
    cleanup();
  }
});
