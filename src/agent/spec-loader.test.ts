import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSpec, specSourceFromEnv, type RunGitClone } from './spec-loader.js';

const VALID_SPEC = `version: "2"
name: TestSpec
target:
  type: web
  url: https://example.test
areas:
  - id: home
    name: Home
    behaviors:
      - id: loads
        description: Home page renders
`;

function tmp(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-loader-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('specSourceFromEnv: returns null when nothing set', () => {
  assert.equal(specSourceFromEnv({}), null);
});

test('specSourceFromEnv: inline', () => {
  const out = specSourceFromEnv({ SPECIFY_SPEC_INLINE_PATH: '/x/spec.yaml' });
  assert.deepEqual(out, { kind: 'inline', path: '/x/spec.yaml' });
});

test('specSourceFromEnv: url with bearer', () => {
  const out = specSourceFromEnv({
    SPECIFY_SPEC_URL: 'https://app/.well-known/specify.spec.yaml',
    SPECIFY_SPEC_URL_BEARER_FILE: '/run/secrets/spec-bearer',
  });
  assert.deepEqual(out, {
    kind: 'url',
    url: 'https://app/.well-known/specify.spec.yaml',
    bearerFile: '/run/secrets/spec-bearer',
  });
});

test('specSourceFromEnv: git requires ref + path', () => {
  assert.throws(() =>
    specSourceFromEnv({ SPECIFY_SPEC_GIT_REPO: 'git@x:y/z.git' })
  , /requires SPECIFY_SPEC_GIT_REF/);
});

test('specSourceFromEnv: rejects multiple sources', () => {
  assert.throws(() =>
    specSourceFromEnv({
      SPECIFY_SPEC_INLINE_PATH: '/a',
      SPECIFY_SPEC_URL: 'https://x',
    })
  , /Multiple spec sources/);
});

test('resolveSpec: inline reads file + hashes content', async () => {
  const { dir, cleanup } = tmp();
  try {
    const p = path.join(dir, 'spec.yaml');
    fs.writeFileSync(p, VALID_SPEC);
    const r = await resolveSpec({ kind: 'inline', path: p });
    assert.equal(r.spec.name, 'TestSpec');
    assert.match(r.hash, /^[a-f0-9]{64}$/);
    assert.equal(r.content, VALID_SPEC);
  } finally {
    cleanup();
  }
});

test('resolveSpec: inline missing path → clear error', async () => {
  await assert.rejects(
    resolveSpec({ kind: 'inline', path: '/nope/missing.yaml' }),
    /Spec file not found/,
  );
});

test('resolveSpec: url with bearer adds Authorization header', async () => {
  const { dir, cleanup } = tmp();
  try {
    const bearerFile = path.join(dir, 'token');
    fs.writeFileSync(bearerFile, 'super-secret\n');
    let seenAuth: string | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenAuth = headers?.Authorization ?? null;
      return new Response(VALID_SPEC, { status: 200 });
    }) as typeof fetch;
    const r = await resolveSpec(
      { kind: 'url', url: 'https://app/spec.yaml', bearerFile },
      { fetchImpl },
    );
    assert.equal(seenAuth, 'Bearer super-secret');
    assert.equal(r.spec.name, 'TestSpec');
  } finally {
    cleanup();
  }
});

test('resolveSpec: url 4xx → descriptive error', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  await assert.rejects(
    resolveSpec({ kind: 'url', url: 'https://app/spec.yaml' }, { fetchImpl }),
    /HTTP 404/,
  );
});

test('resolveSpec: git invokes injected clone, reads path', async () => {
  const { dir: tmpRoot, cleanup } = tmp();
  try {
    const execImpl: RunGitClone = async ({ destDir }) => {
      // Simulate `git clone`: drop the spec into the destination dir.
      fs.mkdirSync(path.join(destDir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(destDir, 'sub', 'spec.yaml'), VALID_SPEC);
    };
    const r = await resolveSpec(
      { kind: 'git', repo: 'git@x:y/z.git', ref: 'main', path: 'sub/spec.yaml' },
      { execImpl, tmpRoot },
    );
    assert.equal(r.spec.name, 'TestSpec');
    assert.equal(r.source.kind, 'git');
  } finally {
    cleanup();
  }
});

test('resolveSpec: git missing path in cloned repo → clear error', async () => {
  const { dir: tmpRoot, cleanup } = tmp();
  try {
    const execImpl: RunGitClone = async ({ destDir }) => {
      fs.mkdirSync(destDir, { recursive: true });
    };
    await assert.rejects(
      resolveSpec(
        { kind: 'git', repo: 'git@x:y/z.git', ref: 'main', path: 'spec.yaml' },
        { execImpl, tmpRoot },
      ),
      /Spec path not found in repo/,
    );
  } finally {
    cleanup();
  }
});
