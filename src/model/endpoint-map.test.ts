import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CapturedTraffic } from '../capture/types.js';
import {
  classifyEndpoint,
  singularize,
  entityFromTemplate,
  pickMarkerField,
  deriveEndpointMap,
  mergeEndpointMap,
  regenerateEndpointMap,
  loadEndpointMap,
  saveEndpointMap,
  setEndpointStatus,
  findEndpoint,
  approvedEndpoints,
  endpointId,
  endpointMapPath,
  emptyEndpointMapFile,
  EndpointMapLoadError,
} from './endpoint-map.js';

// Minimal helper to build a captured request.
function req(
  method: string,
  url: string,
  extra: Partial<CapturedTraffic> = {},
): CapturedTraffic {
  return {
    url,
    method,
    postData: extra.postData ?? null,
    status: extra.status ?? 200,
    contentType: extra.contentType ?? 'application/json',
    ts: extra.ts ?? 0,
    tsStart: extra.tsStart ?? 0,
    tsEnd: extra.tsEnd ?? 0,
    responseBody: extra.responseBody ?? null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// singularize / entityFromTemplate
// ---------------------------------------------------------------------------

test('singularize handles common English plurals', () => {
  assert.equal(singularize('users'), 'user');
  assert.equal(singularize('categories'), 'category');
  assert.equal(singularize('boxes'), 'box');
  assert.equal(singularize('buses'), 'bus');
  assert.equal(singularize('addresses'), 'address'); // -ses stripped
  assert.equal(singularize('class'), 'class'); // -ss unchanged
  assert.equal(singularize('data'), 'data'); // no trailing s
});

test('entityFromTemplate derives resource nearest the terminal', () => {
  assert.equal(entityFromTemplate('/users'), 'user');
  assert.equal(entityFromTemplate('/users/:id'), 'user');
  assert.equal(entityFromTemplate('/users/:id/orders'), 'order');
  assert.equal(entityFromTemplate('/users/:id/orders/:id2'), 'order');
  assert.equal(entityFromTemplate('/'), 'root');
});

// ---------------------------------------------------------------------------
// classifyEndpoint
// ---------------------------------------------------------------------------

test('classifyEndpoint: canonical REST verbs', () => {
  assert.equal(classifyEndpoint('GET', '/users').operation, 'list');
  assert.equal(classifyEndpoint('GET', '/users/:id').operation, 'read');
  assert.equal(classifyEndpoint('POST', '/users').operation, 'create');
  assert.equal(classifyEndpoint('PUT', '/users/:id').operation, 'update');
  assert.equal(classifyEndpoint('PATCH', '/users/:id').operation, 'update');
  assert.equal(classifyEndpoint('DELETE', '/users/:id').operation, 'delete');
});

test('classifyEndpoint: read/update/delete carry the path id location', () => {
  const read = classifyEndpoint('GET', '/users/:id');
  assert.deepEqual(read.idLocation, { kind: 'path', param: 'id' });
  const del = classifyEndpoint('DELETE', '/orders/:id2');
  assert.deepEqual(del.idLocation, { kind: 'path', param: 'id2' });
});

test('classifyEndpoint: high confidence on canonical, low on ambiguous', () => {
  assert.equal(classifyEndpoint('GET', '/users/:id').confidence, 'high');
  // POST on an item template is a custom action, not a plain create.
  const action = classifyEndpoint('POST', '/users/:id');
  assert.equal(action.operation, 'other');
  assert.equal(action.confidence, 'low');
  // Bulk delete on a collection is ambiguous.
  assert.equal(classifyEndpoint('DELETE', '/users').confidence, 'low');
});

test('classifyEndpoint: create derives id field from response body', () => {
  const c = classifyEndpoint('POST', '/users', {
    responseBody: JSON.stringify({ user_id: 7, name: 'x' }),
  });
  assert.equal(c.operation, 'create');
  assert.deepEqual(c.idLocation, { kind: 'body', field: 'user_id' });
});

test('classifyEndpoint: create defaults id field to "id"', () => {
  const c = classifyEndpoint('POST', '/users', { responseBody: '{}' });
  assert.deepEqual(c.idLocation, { kind: 'body', field: 'id' });
});

test('classifyEndpoint: HEAD is a read, unknown method is other', () => {
  assert.equal(classifyEndpoint('HEAD', '/users/:id').operation, 'read');
  assert.equal(classifyEndpoint('OPTIONS', '/users').operation, 'other');
});

// ---------------------------------------------------------------------------
// pickMarkerField
// ---------------------------------------------------------------------------

test('pickMarkerField prefers name/title over other strings', () => {
  assert.equal(pickMarkerField(JSON.stringify({ title: 't', body: 'b' })), 'title');
  assert.equal(pickMarkerField(JSON.stringify({ body: 'b', name: 'n' })), 'name');
});

test('pickMarkerField skips id/timestamp-like fields', () => {
  assert.equal(pickMarkerField(JSON.stringify({ id: '1', user_id: '2', created_at: 'x' })), null);
  assert.equal(pickMarkerField(JSON.stringify({ _internal: 'x', label: 'y' })), 'label');
});

test('pickMarkerField falls back to first writable string field', () => {
  assert.equal(pickMarkerField(JSON.stringify({ foo: 'bar', count: 3 })), 'foo');
  assert.equal(pickMarkerField(JSON.stringify({ count: 3 })), null);
  assert.equal(pickMarkerField('not json'), null);
  assert.equal(pickMarkerField(null), null);
});

// ---------------------------------------------------------------------------
// deriveEndpointMap — fixture REST API
// ---------------------------------------------------------------------------

function fixtureTraffic(): CapturedTraffic[] {
  return [
    // List + read + create + update + delete of users.
    req('GET', 'https://api.example.com/users'),
    req('GET', 'https://api.example.com/users/1'),
    req('GET', 'https://api.example.com/users/2'),
    req('GET', 'https://api.example.com/users/3'),
    req('POST', 'https://api.example.com/users', {
      postData: JSON.stringify({ name: 'Alice', email: 'a@x.com' }),
      responseBody: JSON.stringify({ id: 4, name: 'Alice' }),
      status: 201,
    }),
    req('PATCH', 'https://api.example.com/users/1', {
      postData: JSON.stringify({ name: 'Alice B' }),
    }),
    req('DELETE', 'https://api.example.com/users/2'),
    // Nested orders.
    req('GET', 'https://api.example.com/users/1/orders'),
    req('POST', 'https://api.example.com/users/1/orders', {
      postData: JSON.stringify({ title: 'Widget' }),
      responseBody: JSON.stringify({ id: 99 }),
    }),
  ];
}

test('deriveEndpointMap: fixture REST API collapses ids and classifies', () => {
  const map = deriveEndpointMap(fixtureTraffic());

  // /users/1,2,3 collapse to /users/:id.
  const read = findEndpoint(map, 'GET', '/users/:id');
  assert.ok(read, 'read endpoint present');
  assert.equal(read!.operation, 'read');
  assert.equal(read!.observationCount, 3);
  assert.equal(read!.entity, 'user');

  const list = findEndpoint(map, 'GET', '/users');
  assert.equal(list!.operation, 'list');

  const create = findEndpoint(map, 'POST', '/users');
  assert.equal(create!.operation, 'create');
  assert.equal(create!.markerField, 'name');
  assert.deepEqual(create!.idLocation, { kind: 'body', field: 'id' });

  const update = findEndpoint(map, 'PATCH', '/users/:id');
  assert.equal(update!.operation, 'update');
  assert.equal(update!.markerField, 'name');

  const del = findEndpoint(map, 'DELETE', '/users/:id');
  assert.equal(del!.operation, 'delete');

  const orderList = findEndpoint(map, 'GET', '/users/:id/orders');
  assert.equal(orderList!.operation, 'list');
  assert.equal(orderList!.entity, 'order');
});

test('deriveEndpointMap: all entries start as draft, ambiguous ones need review', () => {
  const map = deriveEndpointMap(fixtureTraffic());
  assert.ok(map.endpoints.every((e) => e.status === 'draft'));
  const create = findEndpoint(map, 'POST', '/users')!;
  assert.equal(create.needs_review, false);
});

test('deriveEndpointMap: output is deterministic and template-sorted', () => {
  const a = deriveEndpointMap(fixtureTraffic(), { provenance: { generated_at: 'T' } });
  const shuffled = [...fixtureTraffic()].reverse();
  const b = deriveEndpointMap(shuffled, { provenance: { generated_at: 'T' } });
  assert.deepEqual(
    a.endpoints.map((e) => `${e.method} ${e.template}`),
    b.endpoints.map((e) => `${e.method} ${e.template}`),
  );
  // Sorted by template.
  const templates = a.endpoints.map((e) => e.template);
  assert.deepEqual(templates, [...templates].sort((x, y) => x.localeCompare(y)));
});

test('endpointId is stable and method+template derived', () => {
  assert.equal(endpointId('get', '/users/:id'), endpointId('GET', '/users/:id'));
  assert.notEqual(endpointId('GET', '/users'), endpointId('POST', '/users'));
});

// ---------------------------------------------------------------------------
// merge — hand-edits survive regeneration
// ---------------------------------------------------------------------------

test('mergeEndpointMap: human corrections and approvals survive regeneration', () => {
  const first = deriveEndpointMap(fixtureTraffic());
  // Human corrects the nested-order create's entity, and approves the read.
  const createOrders = findEndpoint(first, 'POST', '/users/:id/orders')!;
  createOrders.entity = 'purchase-order';
  createOrders.status = 'approved';
  const readUsers = findEndpoint(first, 'GET', '/users/:id')!;
  readUsers.status = 'approved';

  // Regenerate from a later capture (fresh heuristic would say entity=order,
  // status=draft) and merge.
  const { file: merged, preserved } = mergeEndpointMap(first, deriveEndpointMap(fixtureTraffic()));

  const mergedCreate = findEndpoint(merged, 'POST', '/users/:id/orders')!;
  assert.equal(mergedCreate.entity, 'purchase-order', 'hand-edited entity survives');
  assert.equal(mergedCreate.status, 'approved', 'approval survives');
  assert.equal(findEndpoint(merged, 'GET', '/users/:id')!.status, 'approved');
  assert.ok(preserved.includes('POST /users/:id/orders'));
});

test('mergeEndpointMap: new endpoints are added as drafts', () => {
  const first = deriveEndpointMap(fixtureTraffic());
  const withNew = deriveEndpointMap([
    ...fixtureTraffic(),
    req('GET', 'https://api.example.com/products'),
    req('GET', 'https://api.example.com/products/5'),
  ]);
  const { file: merged, added } = mergeEndpointMap(first, withNew);
  assert.ok(added.includes('GET /products'));
  assert.ok(added.includes('GET /products/:id'));
  assert.equal(findEndpoint(merged, 'GET', '/products')!.status, 'draft');
});

test('mergeEndpointMap: removed endpoint flagged stale not deleted', () => {
  const first = deriveEndpointMap(fixtureTraffic());
  // Fresh capture no longer includes DELETE /users/:id but the template still
  // exists (GET/PATCH still hit /users/:id) -> not-observed.
  const withoutDelete = deriveEndpointMap(
    fixtureTraffic().filter((r) => r.method !== 'DELETE'),
  );
  const { file: merged, drifted } = mergeEndpointMap(first, withoutDelete);
  const del = findEndpoint(merged, 'DELETE', '/users/:id')!;
  assert.equal(del.stale, 'not-observed');
  assert.ok(drifted.includes('DELETE /users/:id'));
});

test('mergeEndpointMap: template drift flagged when template disappears', () => {
  const first = deriveEndpointMap([
    req('GET', 'https://api.example.com/legacy-items/1'),
    req('GET', 'https://api.example.com/legacy-items/2'),
  ]);
  const fresh = deriveEndpointMap([
    req('GET', 'https://api.example.com/items/1'),
    req('GET', 'https://api.example.com/items/2'),
  ]);
  const { file: merged } = mergeEndpointMap(first, fresh);
  const legacy = findEndpoint(merged, 'GET', '/legacy-items/:id')!;
  assert.equal(legacy.stale, 'template-drift');
});

test('mergeEndpointMap: re-observing a stale endpoint clears the flag', () => {
  const first = deriveEndpointMap(fixtureTraffic());
  const stale = mergeEndpointMap(first, deriveEndpointMap(fixtureTraffic().filter((r) => r.method !== 'DELETE')));
  assert.equal(findEndpoint(stale.file, 'DELETE', '/users/:id')!.stale, 'not-observed');
  // Now DELETE shows up again.
  const recovered = mergeEndpointMap(stale.file, deriveEndpointMap(fixtureTraffic()));
  assert.equal(findEndpoint(recovered.file, 'DELETE', '/users/:id')!.stale, undefined);
});

test('regenerateEndpointMap: no existing file returns the fresh map', () => {
  const res = regenerateEndpointMap(null, fixtureTraffic());
  assert.equal(res.preserved.length, 0);
  assert.ok(res.added.length > 0);
  assert.equal(res.drifted.length, 0);
});

// ---------------------------------------------------------------------------
// status helpers
// ---------------------------------------------------------------------------

test('setEndpointStatus and approvedEndpoints', () => {
  const map = deriveEndpointMap(fixtureTraffic());
  const read = findEndpoint(map, 'GET', '/users/:id')!;
  const updated = setEndpointStatus(map, read.id, 'approved');
  assert.equal(findEndpoint(updated, 'GET', '/users/:id')!.status, 'approved');
  assert.equal(approvedEndpoints(updated).length, 1);
  assert.throws(() => setEndpointStatus(map, 'ep-nope', 'approved'));
});

test('approvedEndpoints excludes stale entries', () => {
  const map = deriveEndpointMap(fixtureTraffic());
  const del = findEndpoint(map, 'DELETE', '/users/:id')!;
  let file = setEndpointStatus(map, del.id, 'approved');
  // Merge a capture without DELETE -> becomes stale even though approved.
  file = mergeEndpointMap(file, deriveEndpointMap(fixtureTraffic().filter((r) => r.method !== 'DELETE'))).file;
  assert.ok(findEndpoint(file, 'DELETE', '/users/:id')!.stale);
  assert.ok(approvedEndpoints(file).every((e) => e.method !== 'DELETE'));
});

// ---------------------------------------------------------------------------
// persistence round-trip
// ---------------------------------------------------------------------------

test('save/load round-trips and preserves classification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-map-'));
  try {
    const p = endpointMapPath(dir);
    const map = deriveEndpointMap(fixtureTraffic(), { targetKey: 'web_api.example.com' });
    const approved = setEndpointStatus(map, findEndpoint(map, 'GET', '/users/:id')!.id, 'approved');
    saveEndpointMap(p, approved);

    assert.ok(fs.existsSync(p));
    const loaded = loadEndpointMap(p)!;
    assert.equal(loaded.target_key, 'web_api.example.com');
    assert.equal(findEndpoint(loaded, 'GET', '/users/:id')!.status, 'approved');
    assert.deepEqual(loaded.endpoints.map((e) => e.id), approved.endpoints.map((e) => e.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEndpointMap returns null when file absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-map-'));
  try {
    assert.equal(loadEndpointMap(endpointMapPath(dir)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEndpointMap throws on malformed content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-map-'));
  try {
    const p = endpointMapPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });

    fs.writeFileSync(p, 'not json', 'utf-8');
    assert.throws(() => loadEndpointMap(p), EndpointMapLoadError);

    fs.writeFileSync(p, JSON.stringify({ version: 2, endpoints: [] }), 'utf-8');
    assert.throws(() => loadEndpointMap(p), /unsupported version/);

    fs.writeFileSync(p, JSON.stringify({ version: 1 }), 'utf-8');
    assert.throws(() => loadEndpointMap(p), /missing an "endpoints" array/);

    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        templates: [],
        endpoints: [{ id: 'ep-x', method: 'GET', template: '/x', entity: 'x', operation: 'bogus' }],
      }),
      'utf-8',
    );
    assert.throws(() => loadEndpointMap(p), /invalid operation/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emptyEndpointMapFile is loadable after save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-map-'));
  try {
    const p = endpointMapPath(dir);
    saveEndpointMap(p, emptyEndpointMapFile('web_x'));
    const loaded = loadEndpointMap(p)!;
    assert.equal(loaded.endpoints.length, 0);
    assert.equal(loaded.target_key, 'web_x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// "real target" shape: same-origin API subdomain, UUID ids, query strings
// ---------------------------------------------------------------------------

test('deriveEndpointMap: real-ish target with UUIDs and query strings', () => {
  const uuid1 = '550e8400-e29b-41d4-a716-446655440000';
  const uuid2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  const traffic: CapturedTraffic[] = [
    req('GET', `https://app.acme.io/api/v1/projects?limit=20`),
    req('GET', `https://app.acme.io/api/v1/projects/${uuid1}`),
    req('GET', `https://app.acme.io/api/v1/projects/${uuid2}`),
    req('POST', `https://app.acme.io/api/v1/projects`, {
      postData: JSON.stringify({ name: 'New project', visibility: 'private' }),
      responseBody: JSON.stringify({ id: uuid1, name: 'New project' }),
      status: 201,
    }),
    req('DELETE', `https://app.acme.io/api/v1/projects/${uuid1}`),
  ];
  const map = deriveEndpointMap(traffic, { targetKey: 'web_app.acme.io' });

  assert.ok(findEndpoint(map, 'GET', '/api/v1/projects'), 'list projects');
  const read = findEndpoint(map, 'GET', '/api/v1/projects/:id');
  assert.ok(read, 'read collapses both UUIDs');
  assert.equal(read!.observationCount, 2);
  assert.equal(read!.entity, 'project');
  assert.equal(findEndpoint(map, 'POST', '/api/v1/projects')!.markerField, 'name');
  assert.equal(findEndpoint(map, 'DELETE', '/api/v1/projects/:id')!.operation, 'delete');
});
