/**
 * src/agent/k8s-watcher.ts — Cluster-side discovery for the QA pod.
 *
 * Watches Kubernetes Deployments and StatefulSets in the namespaces it has
 * RBAC for, filters by label selector (default `specify.dev/target=true`),
 * and on each rollout-complete event POSTs to the local daemon inbox so a
 * verify run kicks off automatically. No GitHub Actions required, no
 * webhooks the consumer has to wire up — the QA pod sees deploys directly.
 *
 * RBAC is opt-in via the Terraform module; this module assumes the pod has
 * the right verbs (`get/list/watch` on the chosen resources). When perms
 * are missing the watcher logs and exits cleanly so the daemon can keep
 * accepting webhook-mode triggers.
 *
 * Env vars (all optional — when SPECIFY_K8S_WATCH != 'true' the watcher
 * stays asleep and the daemon runs webhook-only):
 *
 *   SPECIFY_K8S_WATCH                 'true' to enable
 *   SPECIFY_K8S_NAMESPACES            comma-separated; empty = all
 *   SPECIFY_K8S_LABEL_SELECTOR        default 'specify.dev/target=true'
 *   SPECIFY_K8S_RESOURCES             comma-separated; default 'deployment,statefulset'
 *   SPECIFY_K8S_LOCAL_INBOX_URL       default 'http://127.0.0.1:4100/inbox'
 *   SPECIFY_INBOX_TOKEN               daemon bearer; passed through Authorization
 */

import { eventBus } from './event-bus.js';

export interface RolloutEvent {
  /** 'deployment' | 'statefulset' | … */
  kind: string;
  namespace: string;
  name: string;
  /** Image of the primary container, when available. */
  image?: string;
  /** Resource version reported by the API. */
  resourceVersion?: string;
}

export interface WatcherConfig {
  enabled: boolean;
  namespaces: string[];
  labelSelector: string;
  resources: Array<'deployment' | 'statefulset'>;
  inboxUrl: string;
  inboxBearer?: string;
}

export interface WatcherDeps {
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Provide a watcher impl directly (testing — bypasses kubernetes client). */
  watcherImpl?: WatcherImpl;
  /** Override stderr writer (testing). */
  log?: (line: string) => void;
}

export interface WatcherImpl {
  start(handler: (ev: RolloutEvent) => void): Promise<() => Promise<void>>;
}

export function watcherConfigFromEnv(env: Record<string, string | undefined> = process.env): WatcherConfig {
  const enabled = env.SPECIFY_K8S_WATCH === 'true' || env.SPECIFY_K8S_WATCH === '1';
  const namespaces = (env.SPECIFY_K8S_NAMESPACES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const labelSelector = env.SPECIFY_K8S_LABEL_SELECTOR ?? 'specify.dev/target=true';
  const rawResources = (env.SPECIFY_K8S_RESOURCES ?? 'deployment,statefulset')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const resources = rawResources
    .filter((r): r is 'deployment' | 'statefulset' => r === 'deployment' || r === 'statefulset');
  const inboxUrl = env.SPECIFY_K8S_LOCAL_INBOX_URL ?? 'http://127.0.0.1:4100/inbox';
  const inboxBearer = env.SPECIFY_INBOX_TOKEN;
  return { enabled, namespaces, labelSelector, resources, inboxUrl, inboxBearer };
}

/**
 * Trigger a verify on the daemon for a given rollout. Exposed so callers
 * (or future trigger sources) can reuse the inbox-posting logic.
 */
export async function triggerVerifyForRollout(
  ev: RolloutEvent,
  cfg: Pick<WatcherConfig, 'inboxUrl' | 'inboxBearer'>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.inboxBearer) headers.Authorization = `Bearer ${cfg.inboxBearer}`;
  const body = {
    task: 'verify',
    prompt: `Verify ${ev.kind}/${ev.namespace}/${ev.name} (image=${ev.image ?? 'unknown'}) against the active spec.`,
    sender: 'k8s-watcher',
    metadata: {
      kind: ev.kind,
      namespace: ev.namespace,
      name: ev.name,
      image: ev.image,
      resourceVersion: ev.resourceVersion,
    },
  };
  const res = await fetchImpl(cfg.inboxUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Inbox POST ${res.status}: ${detail.slice(0, 200)}`);
  }
}

/**
 * Start the watcher. Returns a stop function (idempotent). When config.enabled
 * is false this is a no-op that returns an idle stop function — callers can
 * always invoke `startK8sWatcher()` and rely on env to gate behavior.
 */
export async function startK8sWatcher(
  config: WatcherConfig = watcherConfigFromEnv(),
  deps: WatcherDeps = {},
): Promise<() => Promise<void>> {
  const log = deps.log ?? ((line: string) => process.stderr.write(line));
  if (!config.enabled) {
    return async () => undefined;
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const watcher = deps.watcherImpl ?? (await defaultK8sWatcher(config, log));

  const stop = await watcher.start(async (ev) => {
    eventBus.send('k8s:rollout', {
      kind: ev.kind,
      namespace: ev.namespace,
      name: ev.name,
      image: ev.image,
      resourceVersion: ev.resourceVersion,
    });
    try {
      await triggerVerifyForRollout(ev, config, fetchImpl);
    } catch (err) {
      log(`[k8s-watcher] inbox post failed for ${ev.namespace}/${ev.name}: ${(err as Error).message}\n`);
    }
  });

  return stop;
}

/**
 * Default watcher implementation backed by @kubernetes/client-node informers.
 *
 * Kept lazy-imported so the kubernetes client doesn't load (and try to read
 * cluster config) when watch mode is disabled.
 */
async function defaultK8sWatcher(config: WatcherConfig, log: (line: string) => void): Promise<WatcherImpl> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  // Tries the in-cluster service account first; falls back to ~/.kube/config
  // for local dev. Both produce the same KubeConfig shape downstream.
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  return {
    async start(handler) {
      const informers: Array<{ stop: () => void }> = [];
      const namespaces = config.namespaces.length > 0 ? config.namespaces : [''];
      const labelSelector = config.labelSelector;

      const fire = (kind: string, raw: unknown) => {
        const obj = raw as AppsResource;
        if (!isReady(obj)) return;
        handler(toRollout(kind, obj));
      };

      for (const namespace of namespaces) {
        for (const resource of config.resources) {
          const isDeploy = resource === 'deployment';
          const apiPath = namespace
            ? `/apis/apps/v1/namespaces/${namespace}/${isDeploy ? 'deployments' : 'statefulsets'}`
            : `/apis/apps/v1/${isDeploy ? 'deployments' : 'statefulsets'}`;
          const lister = () => {
            if (isDeploy) {
              return (namespace
                ? apps.listNamespacedDeployment({ namespace, labelSelector })
                : apps.listDeploymentForAllNamespaces({ labelSelector })) as Promise<{ items: AppsResource[] }>;
            }
            return (namespace
              ? apps.listNamespacedStatefulSet({ namespace, labelSelector })
              : apps.listStatefulSetForAllNamespaces({ labelSelector })) as Promise<{ items: AppsResource[] }>;
          };
          const informer = k8s.makeInformer(kc, apiPath, lister, labelSelector);
          informer.on('add', (obj) => fire(resource, obj));
          informer.on('update', (obj) => fire(resource, obj));
          informer.on('error', (err: Error) => {
            log(`[k8s-watcher] informer error (${namespace || 'all'}/${resource}): ${err.message}\n`);
          });
          await informer.start();
          informers.push({ stop: () => informer.stop() });
        }
      }

      return async () => {
        for (const inf of informers) inf.stop();
      };
    },
  };
}

interface AppsResource {
  metadata?: { name?: string; namespace?: string; resourceVersion?: string; generation?: number };
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } };
  status?: {
    observedGeneration?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    replicas?: number;
  };
}

function isReady(obj: AppsResource): boolean {
  const desired = obj.spec?.replicas ?? 0;
  if (desired === 0) return false;
  const status = obj.status ?? {};
  if (status.observedGeneration != null && obj.metadata?.generation != null) {
    if (status.observedGeneration < obj.metadata.generation) return false;
  }
  return (status.readyReplicas ?? 0) >= desired
    && (status.updatedReplicas ?? 0) >= desired
    && (status.replicas ?? 0) === desired;
}

function toRollout(kind: string, obj: AppsResource): RolloutEvent {
  return {
    kind,
    namespace: obj.metadata?.namespace ?? '',
    name: obj.metadata?.name ?? '',
    image: obj.spec?.template?.spec?.containers?.[0]?.image,
    resourceVersion: obj.metadata?.resourceVersion,
  };
}

// Exposed for tests.
export const _internals = { isReady, toRollout };
