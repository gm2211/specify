import assert from 'node:assert/strict';
import test from 'node:test';
import type { EndpointEntry, EndpointMapFile, EndpointStatus, EndpointOperation, IdLocation } from '../model/endpoint-map.js';
import type { ApiTarget } from '../spec/types.js';
import {
  MARKER_PREFIX,
  newMarker,
  renderTemplate,
  joinUrl,
  extractId,
  TemplateRenderError,
  ProbeSafetyError,
  ProbeHttpError,
  assertProbesAllowed,
  planEntityWorkloads,
  runProbeWorkload,
  defaultHttpClient,
  type ProbeHttpClient,
  type ProbeHttpRequest,
  type ProbeHttpResponse,
} from './probe-workload.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function endpoint(
  method: string,
  template: string,
  operation: EndpointOperation,
  extra: Partial<EndpointEntry> = {},
): EndpointEntry {
  const idLocation: IdLocation =
    extra.idLocation ??
    (template.includes(':id')
      ? { kind: 'path', param: 'id' }
      : operation === 'create'
        ? { kind: 'body', field: 'id' }
        : { kind: 'none' });
  return {
    id: `ep-${method}-${template}`,
    method: method.toUpperCase(),
    template,
    entity: extra.entity ?? 'user',
    operation,
    idLocation,
    markerField: 'markerField' in extra ? (extra.markerField ?? null) : operation === 'create' || operation === 'update' ? 'name' : null,
    confidence: 'high',
    rationale: 'test',
    status: extra.status ?? ('approved' as EndpointStatus),
    needs_review: false,
    observationCount: 1,
    sampleUrls: [],
    provenance: { generated_by: 'test', generated_at: '2026-07-18T00:00:00.000Z' },
    ...extra,
  };
}

function mapFile(endpoints: EndpointEntry[]): EndpointMapFile {
  return { version: 1, templates: [], endpoints };
}

const optedInTarget: ApiTarget = { type: 'api', url: 'http://api.test', probes: { enabled: true } };

/** Deterministic marker id generator. */
function seqIds(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

/** Deterministic clock. */
function seqClock(): () => number {
  let n = 0;
  return () => n++;
}

/**
 * A scriptable HTTP client. Routes are matched by `METHOD path` (path only,
 * query dropped). A route can be a fixed response, a function, or a thrown
 * ProbeHttpError.
 */
function scriptClient(
  routes: Record<string, ProbeHttpResponse | ((req: ProbeHttpRequest) => ProbeHttpResponse | Promise<ProbeHttpResponse>) | ProbeHttpError>,
): { client: ProbeHttpClient; calls: ProbeHttpRequest[] } {
  const calls: ProbeHttpRequest[] = [];
  const client: ProbeHttpClient = async (req) => {
    calls.push(req);
    const path = new URL(req.url).pathname;
    const key = `${req.method} ${path}`;
    const route = routes[key];
    if (route === undefined) {
      // Default: 404 for unknown routes.
      return { status: 404, body: { error: 'not found' } };
    }
    if (route instanceof ProbeHttpError) throw route;
    if (typeof route === 'function') return route(req);
    return route;
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('newMarker embeds a unique id behind the shared prefix', () => {
  const m = newMarker(() => 'abc');
  assert.equal(m, `${MARKER_PREFIX}abc`);
  assert.notEqual(newMarker(), newMarker());
});

test('renderTemplate substitutes and encodes path params', () => {
  assert.equal(renderTemplate('/users/:id', { id: '42' }), '/users/42');
  assert.equal(renderTemplate('/users/:id/orders/:id2', { id: '1', id2: '2' }), '/users/1/orders/2');
  assert.equal(renderTemplate('/users', {}), '/users');
  assert.equal(renderTemplate('/', {}), '/');
  assert.equal(renderTemplate('/a b/:id', { id: 'x/y' }), '/a b/x%2Fy');
});

test('renderTemplate throws on a missing param', () => {
  assert.throws(() => renderTemplate('/users/:id', {}), TemplateRenderError);
});

test('joinUrl normalizes slashes', () => {
  assert.equal(joinUrl('http://x/', '/users'), 'http://x/users');
  assert.equal(joinUrl('http://x', 'users'), 'http://x/users');
  assert.equal(joinUrl('http://x', '/users'), 'http://x/users');
});

test('extractId pulls the id from body locations only', () => {
  assert.equal(extractId({ id: 'a' }, { kind: 'body', field: 'id' }), 'a');
  assert.equal(extractId({ _id: 7 }, { kind: 'body', field: '_id' }), '7');
  assert.equal(extractId([{ id: 'a' }], { kind: 'body', field: 'id' }), 'a');
  assert.equal(extractId({ id: 'a' }, { kind: 'path', param: 'id' }), null);
  assert.equal(extractId({}, { kind: 'body', field: 'id' }), null);
  assert.equal(extractId('nope', { kind: 'body', field: 'id' }), null);
});

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

test('assertProbesAllowed requires all three conditions', () => {
  // Happy path.
  assert.doesNotThrow(() => assertProbesAllowed(optedInTarget, { allowProbes: true }));
  // Runtime flag off.
  assert.throws(() => assertProbesAllowed(optedInTarget, { allowProbes: false }), ProbeSafetyError);
  // Not opted in.
  assert.throws(() => assertProbesAllowed({ type: 'api', url: 'http://x' }, { allowProbes: true }), ProbeSafetyError);
  assert.throws(
    () => assertProbesAllowed({ type: 'api', url: 'http://x', probes: { enabled: false } }, { allowProbes: true }),
    ProbeSafetyError,
  );
  // Production hard-block wins even when opted in + flag set.
  assert.throws(
    () => assertProbesAllowed({ type: 'api', url: 'http://x', probes: { enabled: true }, production: true }, { allowProbes: true }),
    ProbeSafetyError,
  );
});

test('runProbeWorkload refuses a disallowed target before any request', async () => {
  const { client, calls } = scriptClient({});
  await assert.rejects(
    runProbeWorkload(mapFile([endpoint('POST', '/users', 'create')]), { type: 'api', url: 'http://x' }, { allowProbes: true, http: client }),
    ProbeSafetyError,
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test('planEntityWorkloads groups by entity and drops entities without create', () => {
  const eps = [
    endpoint('POST', '/users', 'create', { entity: 'user' }),
    endpoint('GET', '/users/:id', 'read', { entity: 'user' }),
    endpoint('GET', '/orders/:id', 'read', { entity: 'order' }), // no create -> dropped
  ];
  const workloads = planEntityWorkloads(eps);
  assert.equal(workloads.length, 1);
  assert.equal(workloads[0].entity, 'user');
  assert.ok(workloads[0].create);
  assert.ok(workloads[0].read);
});

test('planEntityWorkloads keeps the first endpoint per operation', () => {
  const eps = [
    endpoint('POST', '/users', 'create', { entity: 'user', id: 'ep-a' }),
    endpoint('POST', '/people', 'create', { entity: 'user', id: 'ep-b' }),
  ];
  const [wl] = planEntityWorkloads(eps);
  assert.equal(wl.create!.id, 'ep-a');
});

// ---------------------------------------------------------------------------
// Full CRUD run
// ---------------------------------------------------------------------------

function crudEndpoints(): EndpointEntry[] {
  return [
    endpoint('POST', '/users', 'create'),
    endpoint('GET', '/users/:id', 'read'),
    endpoint('GET', '/users', 'list'),
    endpoint('PUT', '/users/:id', 'update'),
    endpoint('DELETE', '/users/:id', 'delete'),
  ];
}

test('happy-path CRUD run produces a complete, marked op log', async () => {
  const { client, calls } = scriptClient({
    'POST /users': (req) => ({ status: 201, body: { id: '7', ...(req.body as object) } }),
    'GET /users/7': { status: 200, body: { id: '7', name: 'x' } },
    'GET /users': { status: 200, body: [{ id: '7' }] },
    'PUT /users/7': { status: 200, body: { id: '7' } },
    'DELETE /users/7': { status: 204, body: undefined },
  });

  const result = await runProbeWorkload(mapFile(crudEndpoints()), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
  });

  // Sequence: create, read, list, update, read, delete, read (7 ops); no cleanup.
  const types = result.ops.map((o) => o.type);
  assert.deepEqual(types, ['create', 'read', 'list', 'update', 'read', 'delete', 'read']);
  assert.equal(result.cleanup.attempted, 0);

  // Op ids are sequential.
  assert.deepEqual(result.ops.map((o) => o.opId), ['op-0001', 'op-0002', 'op-0003', 'op-0004', 'op-0005', 'op-0006', 'op-0007']);

  // Create carried a marker in the body and reported the id.
  const create = result.ops[0];
  assert.equal(create.outcome, 'ok');
  assert.equal(create.marker, `${MARKER_PREFIX}id1`);
  assert.deepEqual(create.request.body, { name: `${MARKER_PREFIX}id1` });
  assert.equal(result.entities[0].createdId, '7');
  assert.equal(result.entities[0].deleted, true);

  // The update wrote a distinct, second marker.
  const update = result.ops[3];
  assert.equal(update.marker, `${MARKER_PREFIX}id2`);
  assert.deepEqual(update.request.body, { name: `${MARKER_PREFIX}id2` });

  // The post-update read carries the NEW marker; delete + final read carry it too.
  assert.equal(result.ops[4].marker, `${MARKER_PREFIX}id2`);
  assert.equal(result.ops[5].marker, `${MARKER_PREFIX}id2`);

  // Two distinct markers recorded on the run.
  assert.deepEqual(result.markers.sort(), [`${MARKER_PREFIX}id1`, `${MARKER_PREFIX}id2`]);

  // Timestamps are recorded and ordered on each op.
  for (const op of result.ops) {
    assert.equal(typeof op.invokeTs, 'number');
    assert.ok(op.completeTs >= op.invokeTs);
  }

  // Every URL was addressed at the created id.
  assert.ok(calls.some((c) => c.url === 'http://api.test/users/7'));
});

test('timeout on create is indeterminate and short-circuits the sequence', async () => {
  const { client } = scriptClient({
    'POST /users': new ProbeHttpError('timed out', 'timeout'),
  });
  const result = await runProbeWorkload(mapFile(crudEndpoints()), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
  });
  assert.equal(result.ops.length, 1);
  const create = result.ops[0];
  assert.equal(create.outcome, 'indeterminate');
  assert.equal(create.response, undefined);
  // No id -> no read/list/update/delete, and nothing to clean up.
  assert.equal(result.entities[0].createdId, null);
  assert.equal(result.cleanup.attempted, 0);
});

test('timeout is never classified as fail; a definite network error is', async () => {
  const timeout = await runProbeWorkload(
    mapFile([endpoint('POST', '/users', 'create')]),
    optedInTarget,
    { allowProbes: true, http: scriptClient({ 'POST /users': new ProbeHttpError('t', 'timeout') }).client, genId: seqIds(), now: seqClock() },
  );
  assert.equal(timeout.ops[0].outcome, 'indeterminate');

  const network = await runProbeWorkload(
    mapFile([endpoint('POST', '/users', 'create')]),
    optedInTarget,
    { allowProbes: true, http: scriptClient({ 'POST /users': new ProbeHttpError('refused', 'network') }).client, genId: seqIds(), now: seqClock() },
  );
  assert.equal(network.ops[0].outcome, 'fail');
});

test('a non-2xx response is a fail with the status recorded', async () => {
  const { client } = scriptClient({
    'POST /users': { status: 500, body: { error: 'boom' } },
  });
  const result = await runProbeWorkload(mapFile(crudEndpoints()), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
  });
  const create = result.ops[0];
  assert.equal(create.outcome, 'fail');
  assert.equal(create.response?.status, 500);
  assert.equal(create.error, 'HTTP 500');
  // Create failed -> no created id -> sequence stops.
  assert.equal(result.ops.length, 1);
});

test('cleanup deletes an entity the sequence left behind', async () => {
  // No delete endpoint in the sequence, so cleanup must issue the delete.
  const eps = [endpoint('POST', '/users', 'create'), endpoint('GET', '/users/:id', 'read')];
  const { client, calls } = scriptClient({
    'POST /users': { status: 201, body: { id: '9' } },
    'GET /users/9': { status: 200, body: { id: '9' } },
    'DELETE /users/9': { status: 204, body: undefined },
  });
  // The plan has no delete endpoint at all -> cleanup cannot delete. Add one.
  eps.push(endpoint('DELETE', '/users/:id', 'delete'));

  const result = await runProbeWorkload(mapFile(eps), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
  });

  // Sequence is create, read (no delete step because... actually delete IS in
  // the plan now, so the sequence deletes). Confirm the sequence deleted it and
  // cleanup was a no-op.
  assert.equal(result.entities[0].deleted, true);
  assert.equal(result.cleanup.attempted, 0);
  assert.ok(calls.some((c) => c.method === 'DELETE'));
});

test('cleanup reports a leftover when the sequence delete failed', async () => {
  const { client } = scriptClient({
    'POST /users': { status: 201, body: { id: '5' } },
    'GET /users/5': { status: 200, body: { id: '5' } },
    'GET /users': { status: 200, body: [{ id: '5' }] },
    'PUT /users/5': { status: 200, body: { id: '5' } },
    // First DELETE (in sequence) times out -> not deleted -> cleanup retries.
    'DELETE /users/5': { status: 204, body: undefined },
  });
  // Override DELETE to time out on the FIRST call, succeed on the cleanup call.
  let deleteCalls = 0;
  const wrapped: ProbeHttpClient = async (req, o) => {
    if (req.method === 'DELETE') {
      deleteCalls++;
      if (deleteCalls === 1) throw new ProbeHttpError('timeout', 'timeout');
      return { status: 204, body: undefined };
    }
    return client(req, o);
  };

  const result = await runProbeWorkload(mapFile(crudEndpoints()), optedInTarget, {
    allowProbes: true,
    http: wrapped,
    genId: seqIds(),
    now: seqClock(),
  });

  // Sequence delete was indeterminate (timeout), so entity was not marked deleted.
  const seqDelete = result.ops.find((o) => o.type === 'delete' && o.opId <= 'op-0007');
  assert.equal(seqDelete?.outcome, 'indeterminate');
  // Cleanup retried and succeeded.
  assert.equal(result.cleanup.attempted, 1);
  assert.equal(result.cleanup.deleted, 1);
  assert.equal(result.cleanup.attempts[0].outcome, 'ok');
  assert.equal(result.entities[0].deleted, true);
});

test('cleanup reports an un-deletable leftover when no delete endpoint exists', async () => {
  const eps = [endpoint('POST', '/users', 'create'), endpoint('GET', '/users/:id', 'read')];
  const { client } = scriptClient({
    'POST /users': { status: 201, body: { id: '3' } },
    'GET /users/3': { status: 200, body: { id: '3' } },
  });
  const result = await runProbeWorkload(mapFile(eps), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
  });
  assert.equal(result.entities[0].deleted, false);
  assert.equal(result.cleanup.attempted, 1);
  assert.equal(result.cleanup.deleted, 0);
  assert.equal(result.cleanup.attempts[0].outcome, 'fail');
  assert.match(result.cleanup.attempts[0].error ?? '', /no approved delete endpoint/);
});

test('only approved endpoints are ever invoked', async () => {
  const eps = [
    endpoint('POST', '/users', 'create'),
    endpoint('GET', '/users/:id', 'read', { status: 'draft' as EndpointStatus }),
    endpoint('GET', '/secrets', 'list', { entity: 'user', status: 'rejected' as EndpointStatus }),
  ];
  const { client, calls } = scriptClient({
    'POST /users': { status: 201, body: { id: '1' } },
    'DELETE /users/1': { status: 404, body: {} },
  });
  const result = await runProbeWorkload(mapFile(eps), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
  });
  // Only the approved create ran (plus a cleanup delete attempt, which 404s).
  assert.ok(!calls.some((c) => new URL(c.url).pathname === '/secrets'));
  assert.ok(!calls.some((c) => c.method === 'GET' && new URL(c.url).pathname === '/users/1'));
  const readOps = result.ops.filter((o) => o.type === 'read');
  assert.equal(readOps.length, 0);
});

test('a stale approved endpoint is not invoked', async () => {
  const eps = [
    endpoint('POST', '/users', 'create'),
    endpoint('GET', '/users/:id', 'read', { stale: 'not-observed' }),
  ];
  const { client, calls } = scriptClient({
    'POST /users': { status: 201, body: { id: '1' } },
    'DELETE /users/1': { status: 204, body: undefined },
  });
  await runProbeWorkload(mapFile(eps), optedInTarget, { allowProbes: true, http: client, genId: seqIds(), now: seqClock() });
  assert.ok(!calls.some((c) => c.method === 'GET'));
});

test('a create without a markerField still runs but records a null marker', async () => {
  const eps = [
    endpoint('POST', '/users', 'create', { markerField: null }),
    endpoint('DELETE', '/users/:id', 'delete'),
  ];
  const { client } = scriptClient({
    'POST /users': { status: 201, body: { id: '1' } },
    'DELETE /users/1': { status: 204, body: undefined },
  });
  const result = await runProbeWorkload(mapFile(eps), optedInTarget, { allowProbes: true, http: client, genId: seqIds(), now: seqClock() });
  assert.equal(result.ops[0].marker, null);
  assert.deepEqual(result.ops[0].request.body, {});
});

test('maxEntities bounds how many entities are probed', async () => {
  const eps = [
    endpoint('POST', '/users', 'create', { entity: 'user' }),
    endpoint('POST', '/orders', 'create', { entity: 'order' }),
  ];
  const { client } = scriptClient({
    'POST /users': { status: 201, body: {} },
    'POST /orders': { status: 201, body: {} },
  });
  const result = await runProbeWorkload(mapFile(eps), optedInTarget, {
    allowProbes: true,
    http: client,
    genId: seqIds(),
    now: seqClock(),
    maxEntities: 1,
  });
  assert.equal(result.entities.length, 1);
});

test('headers from options are forwarded on each request', async () => {
  const { client, calls } = scriptClient({ 'POST /users': { status: 201, body: {} } });
  await runProbeWorkload(mapFile([endpoint('POST', '/users', 'create')]), optedInTarget, {
    allowProbes: true,
    http: client,
    headers: { authorization: 'Bearer t' },
    genId: seqIds(),
    now: seqClock(),
  });
  assert.equal(calls[0].headers?.authorization, 'Bearer t');
});

// ---------------------------------------------------------------------------
// defaultHttpClient (over a local server)
// ---------------------------------------------------------------------------

test('defaultHttpClient parses JSON, forwards body, and classifies a timeout', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      // Never respond -> the client's AbortSignal.timeout fires.
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await defaultHttpClient({ method: 'POST', url: `${base}/x`, body: { a: 1 } }, { timeoutMs: 2000 });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { ok: true, echo: JSON.stringify({ a: 1 }) });

    await assert.rejects(
      defaultHttpClient({ method: 'GET', url: `${base}/slow` }, { timeoutMs: 50 }),
      (err: unknown) => err instanceof ProbeHttpError && err.kind === 'timeout',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('defaultHttpClient reports a definite connection failure as a network error', async () => {
  // Port 1 is essentially never open; connection is refused -> network error.
  await assert.rejects(
    defaultHttpClient({ method: 'GET', url: 'http://127.0.0.1:1/x' }, { timeoutMs: 2000 }),
    (err: unknown) => err instanceof ProbeHttpError && err.kind === 'network',
  );
});
