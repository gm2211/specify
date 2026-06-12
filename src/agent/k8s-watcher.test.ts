import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  _internals,
  startK8sWatcher,
  triggerVerifyForRollout,
  watcherConfigFromEnv,
  type WatcherImpl,
  type RolloutEvent,
} from './k8s-watcher.js';

test('watcherConfigFromEnv: default disabled, default selector + resources', () => {
  const cfg = watcherConfigFromEnv({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.labelSelector, 'specify.dev/target=true');
  assert.deepEqual(cfg.resources, ['deployment', 'statefulset']);
  assert.equal(cfg.inboxUrl, 'http://127.0.0.1:4100/inbox');
  assert.deepEqual(cfg.namespaces, []);
});

test('watcherConfigFromEnv: parses comma-separated namespaces + custom selector', () => {
  const cfg = watcherConfigFromEnv({
    SPECIFY_K8S_WATCH: 'true',
    SPECIFY_K8S_NAMESPACES: 'staging, production ,qa',
    SPECIFY_K8S_LABEL_SELECTOR: 'tier=frontend',
    SPECIFY_K8S_RESOURCES: 'deployment',
    SPECIFY_INBOX_TOKEN: 'tok',
  });
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.namespaces, ['staging', 'production', 'qa']);
  assert.equal(cfg.labelSelector, 'tier=frontend');
  assert.deepEqual(cfg.resources, ['deployment']);
  assert.equal(cfg.inboxBearer, 'tok');
});

test('watcherConfigFromEnv: WATCH=1 also enables', () => {
  assert.equal(watcherConfigFromEnv({ SPECIFY_K8S_WATCH: '1' }).enabled, true);
});

test('isReady: false when desired replicas is 0', () => {
  assert.equal(_internals.isReady({ spec: { replicas: 0 } }), false);
});

test('isReady: false when observedGeneration < generation', () => {
  assert.equal(_internals.isReady({
    metadata: { generation: 4 },
    spec: { replicas: 2 },
    status: { observedGeneration: 3, readyReplicas: 2, updatedReplicas: 2, replicas: 2 },
  }), false);
});

test('isReady: true when ready/updated/replicas all match desired', () => {
  assert.equal(_internals.isReady({
    metadata: { generation: 5 },
    spec: { replicas: 3 },
    status: { observedGeneration: 5, readyReplicas: 3, updatedReplicas: 3, replicas: 3 },
  }), true);
});

test('isReady: false when partial rollout (updatedReplicas < desired)', () => {
  assert.equal(_internals.isReady({
    metadata: { generation: 5 },
    spec: { replicas: 3 },
    status: { observedGeneration: 5, readyReplicas: 3, updatedReplicas: 2, replicas: 3 },
  }), false);
});

test('toRollout: extracts namespace, name, image, resourceVersion', () => {
  const ev = _internals.toRollout('deployment', {
    metadata: { name: 'web', namespace: 'staging', resourceVersion: '42' },
    spec: { replicas: 1, template: { spec: { containers: [{ image: 'web:1.2.3' }] } } },
  });
  assert.deepEqual(ev, {
    kind: 'deployment',
    namespace: 'staging',
    name: 'web',
    image: 'web:1.2.3',
    resourceVersion: '42',
  });
});

test('triggerVerifyForRollout: posts JSON with bearer + metadata', async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const ev: RolloutEvent = {
    kind: 'deployment',
    namespace: 'staging',
    name: 'api',
    image: 'api:abc',
    resourceVersion: '99',
  };
  await triggerVerifyForRollout(
    ev,
    { inboxUrl: 'http://127.0.0.1:4100/inbox', inboxBearer: 'tok' },
    fetchImpl,
  );
  assert.equal(captured.url, 'http://127.0.0.1:4100/inbox');
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  const body = JSON.parse(captured.init?.body as string);
  assert.equal(body.task, 'verify');
  assert.equal(body.sender, 'k8s-watcher');
  assert.equal(body.metadata.namespace, 'staging');
  assert.equal(body.metadata.image, 'api:abc');
});

test('triggerVerifyForRollout: surfaces non-OK as Error', async () => {
  const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  await assert.rejects(
    triggerVerifyForRollout(
      { kind: 'd', namespace: 'n', name: 'x' },
      { inboxUrl: 'http://x/inbox' },
      fetchImpl,
    ),
    /Inbox POST 500/,
  );
});

test('startK8sWatcher: disabled config returns no-op stop', async () => {
  const stop = await startK8sWatcher({
    enabled: false,
    namespaces: [],
    labelSelector: '',
    resources: [],
    inboxUrl: 'http://x/inbox',
    debounceMs: 0,
  });
  await stop();
});

test('startK8sWatcher: rollout event triggers inbox post', async () => {
  let posted = false;
  const fetchImpl = (async () => { posted = true; return new Response('ok', { status: 200 }); }) as typeof fetch;
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      // Synthesize one rollout shortly after start.
      setTimeout(() => handler({ kind: 'deployment', namespace: 'staging', name: 'api' }), 5);
      return async () => undefined;
    },
  };
  const stop = await startK8sWatcher(
    {
      enabled: true,
      namespaces: ['staging'],
      labelSelector: 'specify.dev/target=true',
      resources: ['deployment'],
      inboxUrl: 'http://127.0.0.1:4100/inbox',
      specPath: '/work/specify.spec.yaml',
      debounceMs: 0,
    },
    { fetchImpl, watcherImpl, log: () => undefined, findActiveVerify: async () => undefined },
  );
  await new Promise((r) => setTimeout(r, 30));
  await stop();
  assert.equal(posted, true);
});

// rnz-15c9: isTransientStreamClose
test('isTransientStreamClose: "Premature close" is transient', () => {
  assert.equal(_internals.isTransientStreamClose(new Error('Premature close')), true);
});

test('isTransientStreamClose: EPIPE is transient', () => {
  assert.equal(_internals.isTransientStreamClose(new Error('write EPIPE')), true);
});

test('isTransientStreamClose: ECONNRESET is transient', () => {
  assert.equal(_internals.isTransientStreamClose(new Error('read ECONNRESET')), true);
});

test('isTransientStreamClose: socket hang up is transient', () => {
  assert.equal(_internals.isTransientStreamClose(new Error('socket hang up')), true);
});

test('isTransientStreamClose: auth error is NOT transient', () => {
  assert.equal(_internals.isTransientStreamClose(new Error('Unauthorized: 401')), false);
});

test('isTransientStreamClose: DNS error is NOT transient', () => {
  assert.equal(_internals.isTransientStreamClose(new Error('getaddrinfo ENOTFOUND kubernetes.default.svc')), false);
});


test("startK8sWatcher: inbox failure logged but doesn't throw", async () => {
  const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch;
  let logged = '';
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      setTimeout(() => handler({ kind: 'deployment', namespace: 'n', name: 'x' }), 5);
      return async () => undefined;
    },
  };
  const stop = await startK8sWatcher(
    {
      enabled: true,
      namespaces: [],
      labelSelector: '',
      resources: ['deployment'],
      inboxUrl: 'http://127.0.0.1:4100/inbox',
      specPath: '/work/specify.spec.yaml',
      debounceMs: 0,
    },
    { fetchImpl, watcherImpl, log: (line) => { logged += line; }, findActiveVerify: async () => undefined },
  );
  await new Promise((r) => setTimeout(r, 30));
  await stop();
  assert.match(logged, /inbox post failed/);
});

test('watcherConfigFromEnv: picks up SPECIFY_SPEC_INLINE_PATH into specPath', () => {
  const cfg = watcherConfigFromEnv({ SPECIFY_SPEC_INLINE_PATH: '/work/specify.spec.yaml' });
  assert.equal(cfg.specPath, '/work/specify.spec.yaml');
});

test('triggerVerifyForRollout: includes spec in posted body when specPath set', async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const ev: RolloutEvent = {
    kind: 'deployment',
    namespace: 'staging',
    name: 'api',
    image: 'api:abc',
    resourceVersion: '99',
  };
  await triggerVerifyForRollout(
    ev,
    { inboxUrl: 'http://127.0.0.1:4100/inbox', inboxBearer: 'tok', specPath: '/work/specify.spec.yaml' },
    fetchImpl,
  );
  const body = JSON.parse(captured.init?.body as string);
  assert.equal(body.spec, '/work/specify.spec.yaml');
});

test('triggerVerifyForRollout: omits spec key entirely when specPath unset', async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const ev: RolloutEvent = { kind: 'deployment', namespace: 'staging', name: 'api' };
  await triggerVerifyForRollout(
    ev,
    { inboxUrl: 'http://127.0.0.1:4100/inbox' },
    fetchImpl,
  );
  const body = JSON.parse(captured.init?.body as string);
  assert.equal('spec' in body, false);
});

test('startK8sWatcher: no specPath posts rollout verify for inbox env fallback', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  let logged = '';
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      setTimeout(() => handler({ kind: 'deployment', namespace: 'n', name: 'x' }), 5);
      return async () => undefined;
    },
  };
  const stop = await startK8sWatcher(
    {
      enabled: true,
      namespaces: [],
      labelSelector: '',
      resources: ['deployment'],
      inboxUrl: 'http://127.0.0.1:4100/inbox',
      debounceMs: 0,
    },
    { fetchImpl, watcherImpl, log: (line) => { logged += line; }, findActiveVerify: async () => undefined },
  );
  await new Promise((r) => setTimeout(r, 30));
  await stop();
  assert.equal(capturedBody?.task, 'verify');
  assert.equal('spec' in (capturedBody ?? {}), false);
  assert.match(logged, /inbox accepted verify/);
});

// ---------------------------------------------------------------------------
// SP-mn7: debounce + active-job suppression tests
// ---------------------------------------------------------------------------

/** Helper: build a minimal enabled WatcherConfig. */
function cfg(overrides: Partial<{ debounceMs: number }> = {}): Parameters<typeof startK8sWatcher>[0] {
  return {
    enabled: true,
    namespaces: [],
    labelSelector: '',
    resources: ['deployment'],
    inboxUrl: 'http://127.0.0.1:4100/inbox',
    debounceMs: overrides.debounceMs ?? 600_000,
  } as Parameters<typeof startK8sWatcher>[0];
}

test('debounce: two back-to-back events for same workload → exactly one POST, suppression logged', async () => {
  let postCount = 0;
  const fetchImpl = (async () => { postCount++; return new Response('ok', { status: 200 }); }) as typeof fetch;
  let logged = '';
  let fireHandler: ((ev: RolloutEvent) => void) | undefined;
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      fireHandler = handler;
      return async () => undefined;
    },
  };
  let fakeNow = 1_000_000;
  const stop = await startK8sWatcher(cfg({ debounceMs: 60_000 }), {
    fetchImpl,
    watcherImpl,
    log: (line) => { logged += line; },
    now: () => fakeNow,
    findActiveVerify: async () => undefined,
  });

  const ev: RolloutEvent = { kind: 'deployment', namespace: 'staging', name: 'api', image: 'api:1' };
  fireHandler!(ev);
  // Second event arrives 5 seconds later — well within debounce window.
  fakeNow += 5_000;
  fireHandler!(ev);

  await new Promise((r) => setTimeout(r, 30));
  await stop();

  assert.equal(postCount, 1, 'exactly one POST');
  assert.match(logged, /duplicate verify suppressed/);
  assert.match(logged, /reason=debounce/);
});

test('debounce: second event after window elapsed → second POST allowed', async () => {
  let postCount = 0;
  const fetchImpl = (async () => { postCount++; return new Response('ok', { status: 200 }); }) as typeof fetch;
  let fireHandler: ((ev: RolloutEvent) => void) | undefined;
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      fireHandler = handler;
      return async () => undefined;
    },
  };
  let fakeNow = 1_000_000;
  const stop = await startK8sWatcher(cfg({ debounceMs: 60_000 }), {
    fetchImpl,
    watcherImpl,
    log: () => undefined,
    now: () => fakeNow,
    findActiveVerify: async () => undefined,
  });

  const ev: RolloutEvent = { kind: 'deployment', namespace: 'prod', name: 'svc', image: 'svc:2' };
  fireHandler!(ev);
  await new Promise((r) => setTimeout(r, 10));

  // Advance clock past the window.
  fakeNow += 61_000;
  fireHandler!(ev);
  await new Promise((r) => setTimeout(r, 10));
  await stop();

  assert.equal(postCount, 2, 'second POST after window elapsed');
});

test('debounce: different image → both events POST (no suppression)', async () => {
  let postCount = 0;
  const fetchImpl = (async () => { postCount++; return new Response('ok', { status: 200 }); }) as typeof fetch;
  let fireHandler: ((ev: RolloutEvent) => void) | undefined;
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      fireHandler = handler;
      return async () => undefined;
    },
  };
  let fakeNow = 1_000_000;
  const stop = await startK8sWatcher(cfg({ debounceMs: 60_000 }), {
    fetchImpl,
    watcherImpl,
    log: () => undefined,
    now: () => fakeNow,
    findActiveVerify: async () => undefined,
  });

  fireHandler!({ kind: 'deployment', namespace: 'staging', name: 'api', image: 'api:1' });
  fakeNow += 1_000;
  fireHandler!({ kind: 'deployment', namespace: 'staging', name: 'api', image: 'api:2' });

  await new Promise((r) => setTimeout(r, 30));
  await stop();

  assert.equal(postCount, 2, 'different images must not debounce each other');
});

test('active-job: findActiveVerify returns active job → no POST, suppression logged', async () => {
  let postCount = 0;
  const fetchImpl = (async () => { postCount++; return new Response('ok', { status: 200 }); }) as typeof fetch;
  let logged = '';
  let fireHandler: ((ev: RolloutEvent) => void) | undefined;
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      fireHandler = handler;
      return async () => undefined;
    },
  };
  const stop = await startK8sWatcher(cfg({ debounceMs: 0 }), {
    fetchImpl,
    watcherImpl,
    log: (line) => { logged += line; },
    findActiveVerify: async () => ({ id: 'msg_abc123', status: 'running' }),
  });

  fireHandler!({ kind: 'deployment', namespace: 'qa', name: 'frontend', image: 'fe:3' });
  await new Promise((r) => setTimeout(r, 20));
  await stop();

  assert.equal(postCount, 0, 'no POST when active job present');
  assert.match(logged, /duplicate verify suppressed/);
  assert.match(logged, /reason=active-job msg_abc123 status=running/);
});

test('debounce cleared on POST failure: failed event → retry on next event', async () => {
  let callCount = 0;
  let failFirst = true;
  const fetchImpl = (async () => {
    callCount++;
    if (failFirst) {
      failFirst = false;
      return new Response('err', { status: 503 });
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  let fireHandler: ((ev: RolloutEvent) => void) | undefined;
  const watcherImpl: WatcherImpl = {
    async start(handler) {
      fireHandler = handler;
      return async () => undefined;
    },
  };
  let fakeNow = 1_000_000;
  const stop = await startK8sWatcher(cfg({ debounceMs: 60_000 }), {
    fetchImpl,
    watcherImpl,
    log: () => undefined,
    now: () => fakeNow,
    findActiveVerify: async () => undefined,
  });

  const ev: RolloutEvent = { kind: 'deployment', namespace: 'test', name: 'app', image: 'app:1' };
  fireHandler!(ev);
  await new Promise((r) => setTimeout(r, 20));
  // First call failed; debounce entry should be cleared.
  // Second event (still within window) should also be attempted.
  fakeNow += 5_000;
  fireHandler!(ev);
  await new Promise((r) => setTimeout(r, 20));
  await stop();

  assert.equal(callCount, 2, 'failed POST clears debounce; retry on next event');
});

test('watcherConfigFromEnv: SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES unset → 600000ms', () => {
  const c = watcherConfigFromEnv({});
  assert.equal(c.debounceMs, 600_000);
});

test('watcherConfigFromEnv: SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES="0" → 0', () => {
  const c = watcherConfigFromEnv({ SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES: '0' });
  assert.equal(c.debounceMs, 0);
});

test('watcherConfigFromEnv: SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES="2.5" → 150000ms', () => {
  const c = watcherConfigFromEnv({ SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES: '2.5' });
  assert.equal(c.debounceMs, 150_000);
});
