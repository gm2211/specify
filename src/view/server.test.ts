import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startViewer } from './server.js';

function yaml(name: string, description = 'First'): string {
  return `version: '2'\nname: ${name}\ndescription: ${description}\ntarget:\n  type: cli\n  binary: secret-binary\n  env:\n    SECRET: hidden\nvariables:\n  api_key: hidden\nassumptions:\n  - description: app is available\n    check: curl localhost\nhooks:\n  setup:\n  - name: secret hook\n    run: secret command\nareas:\n- id: auth\n  name: Authentication\n  behaviors:\n  - id: login\n    description: Login works\n`;
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{
    status: number;
    headers: import('node:http').IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function close(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test('viewer reloads spec data, returns errors for invalid updates, and recovers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-view-'));
  const path = join(dir, 'spec.yaml');
  writeFileSync(path, yaml('Viewer', 'First description'));
  const viewer = await startViewer(path);
  try {
    const page = await get(viewer.url);
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(String(page.headers['content-security-policy'] ?? ''), /script-src 'self'/);
    const client = await get(`${viewer.url}client.js`);
    assert.equal(client.status, 200);
    assert.match(String(client.headers['content-type'] ?? ''), /javascript/);
    assert.match(client.body, /\/spec/);
    const first = await get(`${viewer.url}spec`);
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-store');
    const parsed = JSON.parse(first.body);
    assert.equal(parsed.name, 'Viewer');
    assert.equal(parsed.description, 'First description');
    assert.deepEqual(Object.keys(parsed).sort(), ['areas', 'assumptions', 'description', 'name']);
    assert.doesNotMatch(first.body, /hidden|secret/);

    writeFileSync(path, 'not: [valid');
    const invalid = await get(`${viewer.url}spec`);
    assert.equal(invalid.status, 500);
    writeFileSync(path, yaml('Updated', 'Fresh description'));
    const recovered = await get(`${viewer.url}spec`);
    assert.equal(recovered.status, 200);
    assert.equal(JSON.parse(recovered.body).name, 'Updated');
    assert.equal(JSON.parse(recovered.body).description, 'Fresh description');
  } finally {
    await close(viewer.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer validates initial spec before listening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-view-invalid-'));
  const path = join(dir, 'spec.yaml');
  writeFileSync(path, 'invalid: true');
  try {
    await assert.rejects(startViewer(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer rejects foreign hosts, origins, methods, and unknown routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'specify-view-guard-'));
  const path = join(dir, 'spec.yaml');
  writeFileSync(path, yaml('Guarded'));
  const viewer = await startViewer(path);
  try {
    const host = `127.0.0.1:${new URL(viewer.url).port}`;
    const foreignHost = await get(`${viewer.url}spec`, { Host: 'attacker.example' });
    assert.equal(foreignHost.status, 403);
    const foreignOrigin = await get(`${viewer.url}spec`, {
      Host: host,
      Origin: 'https://attacker.example',
    });
    assert.equal(foreignOrigin.status, 403);
    const post = await get(`${viewer.url}spec`, { Host: host }, 'POST');
    assert.equal(post.status, 405);
    const missing = await get(`${viewer.url}missing`, { Host: host });
    assert.equal(missing.status, 404);
  } finally {
    await close(viewer.server);
    rmSync(dir, { recursive: true, force: true });
  }
});
