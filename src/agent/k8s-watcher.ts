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
 *   SPECIFY_SPEC_INLINE_PATH          optional path forwarded as `spec` in verify
 *                                     payloads; when unset inbox resolves env source
 *   SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES
 *                                     float; default 10. Suppress duplicate verify
 *                                     POSTs for the same workload within this window.
 *                                     Set to 0 to disable time-based debounce (active-
 *                                     job dedup still applies). Explicit "0" disables;
 *                                     unset uses the 10-minute default.
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

/** Minimal shape returned by findActiveVerify — typed loosely to avoid
 *  importing daemon types eagerly into the agent module. */
interface ActiveVerifyResult {
  id: string;
  status: string;
}

export interface WatcherConfig {
  enabled: boolean;
  namespaces: string[];
  labelSelector: string;
  resources: Array<'deployment' | 'statefulset'>;
  inboxUrl: string;
  inboxBearer?: string;
  /**
   * Path to the spec file forwarded as `spec` in verify payloads.
   * Sourced from SPECIFY_SPEC_INLINE_PATH. When absent, the verify payload
   * omits `spec` so the inbox can resolve the daemon's configured source.
   */
  specPath?: string;
  /**
   * How long (ms) to suppress duplicate verify POSTs for the same workload
   * after the first successful POST. 0 = disabled (active-job dedup still
   * applies). Default 600_000 (10 minutes).
   */
  debounceMs: number;
}

export interface WatcherDeps {
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Provide a watcher impl directly (testing — bypasses kubernetes client). */
  watcherImpl?: WatcherImpl;
  /** Override stderr writer (testing). */
  log?: (line: string) => void;
  /**
   * Check whether a queued/running verify already exists for the given workload.
   * Return value shape: { id, status } when found, undefined/null when not.
   * When omitted, the default implementation lazy-imports the inbox module and
   * calls inbox.findActiveVerify() — which is correct in-process but cannot
   * be used in unit tests that don't spin up the daemon.
   */
  findActiveVerify?: (target: { namespace: string; name: string; image?: string }) => Promise<ActiveVerifyResult | undefined | null> | ActiveVerifyResult | undefined | null;
  /**
   * Clock override for deterministic tests. Defaults to Date.now.
   */
  now?: () => number;
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
  const specPath = env.SPECIFY_SPEC_INLINE_PATH;

  // Debounce: unset → 10 min default; explicit "0" (or <= 0 / NaN) → 0 (disabled).
  let debounceMs: number;
  if (env.SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES === undefined) {
    debounceMs = 10 * 60_000;
  } else {
    const parsed = parseFloat(env.SPECIFY_K8S_VERIFY_DEBOUNCE_MINUTES);
    debounceMs = (!isNaN(parsed) && parsed > 0) ? parsed * 60_000 : 0;
  }

  return { enabled, namespaces, labelSelector, resources, inboxUrl, inboxBearer, specPath, debounceMs };
}

/**
 * Trigger a verify on the daemon for a given rollout. Exposed so callers
 * (or future trigger sources) can reuse the inbox-posting logic.
 */
export async function triggerVerifyForRollout(
  ev: RolloutEvent,
  cfg: Pick<WatcherConfig, 'inboxUrl' | 'inboxBearer' | 'specPath'>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.inboxBearer) headers.Authorization = `Bearer ${cfg.inboxBearer}`;
  const body = {
    task: 'verify',
    prompt: `Verify ${ev.kind}/${ev.namespace}/${ev.name} (image=${ev.image ?? 'unknown'}) against the active spec.`,
    sender: 'k8s-watcher',
    ...(cfg.specPath ? { spec: cfg.specPath } : {}),
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
 * Default findActiveVerify implementation: lazy-imports the inbox module so
 * the kubernetes client / daemon code doesn't load when the watcher is disabled.
 * Fail-open: if the import or call throws, log and return undefined so the
 * watcher proceeds with the verify rather than silently dropping it.
 */
async function defaultFindActiveVerify(
  target: { namespace: string; name: string; image?: string },
  log: (line: string) => void,
): Promise<ActiveVerifyResult | undefined> {
  try {
    const { inbox } = await import('../daemon/inbox.js');
    const effectiveUrl = process.env.SPECIFY_TARGET_URL?.trim() || undefined;
    const found = inbox.findActiveVerify(target, effectiveUrl);
    if (!found) return undefined;
    return { id: found.id, status: found.status };
  } catch (err) {
    log(`[k8s-watcher] findActiveVerify check failed (fail-open): ${(err as Error).message}\n`);
    return undefined;
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
    log('[k8s-watcher] disabled (SPECIFY_K8S_WATCH != true)\n');
    return async () => undefined;
  }

  // rnz-ukd9: surface watcher config + lifecycle so silent-failure modes
  // (RBAC missing, informer.start hanging, isReady() filtering everything
  // out) are visible in pod logs.
  log(`[k8s-watcher] enabled namespaces=[${config.namespaces.join(',')}] selector=${config.labelSelector} resources=[${config.resources.join(',')}] inboxUrl=${config.inboxUrl} specPath=${config.specPath ?? 'none'} debounceMs=${config.debounceMs}\n`);

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const findActiveVerify = deps.findActiveVerify ??
    ((target) => defaultFindActiveVerify(target, log));

  let watcher: WatcherImpl;
  try {
    watcher = deps.watcherImpl ?? (await defaultK8sWatcher(config, log));
  } catch (err) {
    log(`[k8s-watcher] init failed: ${(err as Error).message}\n`);
    throw err;
  }

  // Per-watcher debounce map: targetKey → timestamp of last successful POST.
  const lastPosted = new Map<string, number>();

  const stop = await watcher.start(async (ev) => {
    // Log the rollout detection and emit observability event unconditionally.
    log(`[k8s-watcher] rollout detected ${ev.namespace}/${ev.name} kind=${ev.kind} image=${ev.image ?? 'unknown'} rv=${ev.resourceVersion ?? '?'}\n`);
    eventBus.send('k8s:rollout', {
      kind: ev.kind,
      namespace: ev.namespace,
      name: ev.name,
      image: ev.image,
      resourceVersion: ev.resourceVersion,
    });

    const targetKey = `${ev.namespace}/${ev.name}@${ev.image ?? 'unknown'}`;
    const nowMs = now();

    // Prune stale debounce entries before checking (bounds memory on long-running watchers).
    if (config.debounceMs > 0) {
      for (const [key, ts] of lastPosted) {
        if (nowMs - ts >= config.debounceMs) lastPosted.delete(key);
      }
    }

    // --- Debounce check (time-based) ---
    if (config.debounceMs > 0) {
      const lastTs = lastPosted.get(targetKey);
      if (lastTs !== undefined) {
        const elapsedMs = nowMs - lastTs;
        if (elapsedMs < config.debounceMs) {
          const elapsedSec = Math.round(elapsedMs / 1000);
          log(`[k8s-watcher] duplicate verify suppressed for ${ev.namespace}/${ev.name} (image=${ev.image ?? 'unknown'}, reason=debounce, last posted ${elapsedSec}s ago)\n`);
          return;
        }
      }
    }

    // Record the post time BEFORE any async checks so near-simultaneous
    // add+update events (arriving while checks are in flight) are also
    // suppressed. We clear the entry on active-job suppression or POST failure.
    lastPosted.set(targetKey, nowMs);

    // --- Active-job check (always runs, even when debounce is disabled) ---
    const active = await findActiveVerify({ namespace: ev.namespace, name: ev.name, image: ev.image });
    if (active) {
      lastPosted.delete(targetKey);
      log(`[k8s-watcher] duplicate verify suppressed for ${ev.namespace}/${ev.name} (image=${ev.image ?? 'unknown'}, reason=active-job ${active.id} status=${active.status})\n`);
      return;
    }

    log(`[k8s-watcher] posting verify for ${ev.namespace}/${ev.name}\n`);
    try {
      await triggerVerifyForRollout(ev, config, fetchImpl);
      log(`[k8s-watcher] inbox accepted verify for ${ev.namespace}/${ev.name}\n`);
    } catch (err) {
      // On failure, clear the debounce entry so the next event retries.
      lastPosted.delete(targetKey);
      log(`[k8s-watcher] inbox post failed for ${ev.namespace}/${ev.name}: ${(err as Error).message}\n`);
    }
  });

  log(`[k8s-watcher] subscribed — waiting for rollout events\n`);
  return stop;
}

/**
 * Returns true for errors that represent a normal apiserver-side stream close
 * (idle timeout, proxy EPIPE, connection reset by peer). These are expected
 * every ~5 minutes in a typical cluster and should trigger an immediate,
 * quiet reconnect — NOT a 5-second backoff with a prominent warning.
 *
 * Genuine errors (auth failures, DNS failures, 5xx) return false and keep
 * the existing backoff + loud log so real problems are visible.
 */
function isTransientStreamClose(err: Error): boolean {
  const msg = err.message ?? '';
  // Node.js HTTP parser signals an abrupt EOF as "Premature close"
  if (msg.includes('Premature close')) return true;
  // Broken-pipe when the apiserver closes the keep-alive connection
  if (msg.includes('EPIPE')) return true;
  // Connection reset by peer (proxy / NAT timeout)
  if (msg.includes('ECONNRESET')) return true;
  // Node undici / fetch-level socket EOF
  if (msg.includes('UND_ERR_SOCKET') || msg.includes('socket hang up')) return true;
  // HTTP/2 stream reset when apiserver sends RST_STREAM on idle timeout
  if (msg.includes('ERR_HTTP2_STREAM_CANCEL') || msg.includes('ERR_HTTP2_SESSION_ERROR')) return true;
  return false;
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

      // rnz-ukd9: log every event + isReady() result so we can see why the
      // watcher might silently skip rollouts.
      const fire = (kind: string, event: 'add' | 'update', raw: unknown) => {
        const obj = raw as AppsResource;
        const name = obj.metadata?.name ?? '?';
        const ns = obj.metadata?.namespace ?? '?';
        const ready = isReady(obj);
        const desired = obj.spec?.replicas ?? 0;
        const status = obj.status ?? {};
        log(`[k8s-watcher] event=${event} kind=${kind} ${ns}/${name} desired=${desired} ready=${status.readyReplicas ?? 0} updated=${status.updatedReplicas ?? 0} repl=${status.replicas ?? 0} obsGen=${status.observedGeneration ?? '?'}/gen=${obj.metadata?.generation ?? '?'} → ${ready ? 'FIRE' : 'skip'}\n`);
        if (!ready) return;
        handler(toRollout(kind, obj));
      };

      // Track watchdog intervals so we can clear them on stop.
      const watchdogTimers: ReturnType<typeof setInterval>[] = [];

      for (const namespace of namespaces) {
        for (const resource of config.resources) {
          const isDeploy = resource === 'deployment';
          const apiPath = namespace
            ? `/apis/apps/v1/namespaces/${namespace}/${isDeploy ? 'deployments' : 'statefulsets'}`
            : `/apis/apps/v1/${isDeploy ? 'deployments' : 'statefulsets'}`;
          log(`[k8s-watcher] starting informer ns=${namespace || 'all'} resource=${resource} path=${apiPath}\n`);
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

          // Per-informer state for debounce and watchdog.
          let restartTimer: ReturnType<typeof setTimeout> | null = null;
          let lastEventTs = Date.now();

          /**
           * Schedule an informer restart.
           *
           * @param reason  Short description for logging.
           * @param delayMs Milliseconds to wait before restarting.
           *   0  = reconnect immediately (used for transient stream closes).
           *   5000 (default) = back off for real errors.
           */
          const scheduleRestart = (reason: string, delayMs = 5_000) => {
            if (restartTimer) return; // already scheduled
            restartTimer = setTimeout(async () => {
              restartTimer = null;
              lastEventTs = Date.now(); // reset so watchdog doesn't immediately re-trigger
              try {
                await informer.start();
                log(`[k8s-watcher] informer reconnected ns=${namespace || 'all'} resource=${resource}\n`);
              } catch (restartErr) {
                log(`[k8s-watcher] informer restart failed ns=${namespace || 'all'} resource=${resource}: ${(restartErr as Error).message}\n`);
                // Back off and try again rather than going silent.
                scheduleRestart('restart-failed');
              }
            }, delayMs);
            if (delayMs > 0) {
              log(`[k8s-watcher] informer ${reason} (${namespace || 'all'}/${resource}) — scheduling restart in ${delayMs / 1000}s\n`);
            }
          };

          const touchEvent = () => { lastEventTs = Date.now(); };

          informer.on('add', (obj) => { touchEvent(); fire(resource, 'add', obj); });
          informer.on('update', (obj) => { touchEvent(); fire(resource, 'update', obj); });
          informer.on('error', (err: Error) => {
            touchEvent();
            if (isTransientStreamClose(err)) {
              // Normal apiserver stream EOF (idle timeout, EPIPE, connection reset).
              // Reconnect immediately and quietly — no backoff, no noise.
              log(`[k8s-watcher] informer stream closed (${namespace || 'all'}/${resource}): ${err.message} — reconnecting\n`);
              scheduleRestart(`stream-close: ${err.message}`, 0);
            } else {
              log(`[k8s-watcher] informer error (${namespace || 'all'}/${resource}): ${err.message} — scheduling restart in 5s\n`);
              scheduleRestart(`error: ${err.message}`);
            }
          });

          try {
            await informer.start();
            log(`[k8s-watcher] informer started ns=${namespace || 'all'} resource=${resource}\n`);
          } catch (err) {
            log(`[k8s-watcher] informer.start failed ns=${namespace || 'all'} resource=${resource}: ${(err as Error).message}\n`);
            throw err;
          }

          // Idle watchdog: if no event fires for 10 minutes, the watch stream
          // has silently died. Log and restart.
          const IDLE_THRESHOLD_MS = 10 * 60 * 1_000;
          const watchdog = setInterval(() => {
            const idleMs = Date.now() - lastEventTs;
            if (idleMs > IDLE_THRESHOLD_MS) {
              log(`[k8s-watcher] watchdog: ns=${namespace || 'all'} resource=${resource} idle ${Math.round(idleMs / 1000)}s — scheduling restart\n`);
              scheduleRestart('watchdog-idle');
            }
          }, 60_000);
          watchdogTimers.push(watchdog);

          informers.push({ stop: () => { clearTimeout(restartTimer ?? undefined); informer.stop(); } });
        }
      }

      return async () => {
        for (const t of watchdogTimers) clearInterval(t);
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
export const _internals = { isReady, toRollout, isTransientStreamClose };
