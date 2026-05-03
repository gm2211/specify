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
    },
    { fetchImpl, watcherImpl, log: () => undefined },
  );
  await new Promise((r) => setTimeout(r, 30));
  await stop();
  assert.equal(posted, true);
});

test('startK8sWatcher: inbox failure logged but doesn’t throw', async () => {
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
    },
    { fetchImpl, watcherImpl, log: (line) => { logged += line; } },
  );
  await new Promise((r) => setTimeout(r, 30));
  await stop();
  assert.match(logged, /inbox post failed/);
});
