# specify-qa

Terraform module that drops a continuously-running QA agent into a Kubernetes
cluster. The agent verifies a target application against its spec, learns
across runs (memory rows, confidence stats, mined skill drafts), and reports
results to one or more sinks. Per-spec PVC keeps the learning durable across
pod restarts.

```
                         ┌──────────────────────┐
       app under test ─▶ │ specify-qa Deployment│ ─▶ Slack / file reports
       k8s rollouts  ─▶ │   /inbox 4100        │
                         │   PVC /work          │  ← memory.json,
                         └──────────────────────┘     sessions.db,
                                                       skill drafts
```

## Usage

```hcl
module "qa_renzo" {
  source = "github.com/gm2211/specify//deploy/terraform/modules/specify-qa?ref=main"

  name      = "renzo-qa"
  namespace = "qa"

  # Pick exactly one target_*
  target_url = "http://renzo.app.svc.cluster.local:8080"

  # Pick exactly one spec_*
  spec_inline = file("${path.module}/specify.spec.yaml")

  # Optional discovery — `watch` opens informers, `webhook` stays passive
  discovery = {
    mode       = "watch"
    namespaces = ["staging"]
  }

  # Optional report sinks
  report_slack_webhook = var.slack_webhook_url

  anthropic_api_key_secret = "anthropic-api-key" # pre-existing Secret with key `api-key`
}
```

## Inputs reference

| Group | Variable | Notes |
|-------|----------|-------|
| target | `target_url` | direct URL |
| target | `target_dns` | bare hostname (`http://<dns>` at runtime) |
| target | `target_cluster_ip` | IP[:port] — bypass DNS |
| target | `target_from_configmap` | `{name, key}` — read URL from another ConfigMap at startup |
| spec | `spec_inline` | spec YAML; baked into a ConfigMap |
| spec | `spec_url` | + optional `spec_url_bearer` (auto-generated if empty) |
| spec | `spec_git` | `{repo, ref, path, deploy_key_secret?}` |
| discovery | `discovery.mode` | `webhook` (default) / `watch` / `both` / `none` |
| discovery | `discovery.namespaces` | list — empty = all (cluster scope) |
| discovery | `discovery.label_selector` | default `specify.dev/target=true` |
| discovery | `discovery.rbac_scope` | `namespace` (default) / `cluster` |
| reports | `report_file_dir` | default `/work/reports` (PVC-backed) |
| reports | `report_slack_webhook` | empty disables slack sink |
| auth | `anthropic_api_key_secret` | name of Secret with key `api-key` |
| auth | `inbox_token` | empty = auto-generate; surfaced via output |
| storage | `pvc_size` | default `5Gi` |
| storage | `pvc_storage_class` | empty = cluster default |

Pick **exactly one** target and **exactly one** spec source — the module
fails plan with a clear error otherwise.

## Outputs

| Output | What |
|--------|------|
| `inbox_url` | URL to POST verify webhooks to |
| `inbox_token` | Bearer to send with the webhook (sensitive) |
| `spec_url_bearer` | Bearer the pod uses to fetch `spec_url` (sensitive) |
| `service_dns` | Cluster-internal DNS |
| `service_account_name` | For NetworkPolicy / pod-identity rules |
| `pvc_name` | The PVC backing `/work` |

## Discovery modes

* `webhook` — daemon sits idle, your CI / Argo / GH Actions POST to `inbox_url`.
* `watch` — daemon opens k8s informers on Deployments / StatefulSets matching
  `discovery.label_selector` in `discovery.namespaces`. Each completed rollout
  triggers a verify automatically.
* `both` — informers + accepts webhooks.
* `none` — manual only (useful for stepping through reports interactively).

`watch` adds RBAC (Role+RoleBinding for `namespace` scope, ClusterRole+Binding
for `cluster` scope). The pod runs under a ServiceAccount the module also
creates.

## Spec rotation

After deploying a new version of the app under test, hit
`POST /control/reload-spec` on the daemon (works for `spec_url` and
`spec_git`). Memory rows are tagged with the spec hash so behavioural
expectations from prior versions stay queryable.

## State on disk (PVC-backed `/work`)

| Path | Content |
|------|---------|
| `/work/.specify/memory/<spec_id>/<target>.json` | learned memory rows |
| `/work/.specify/sessions.db` | session SQLite + FTS5 |
| `/work/.specify/skill-drafts/` | mined skills awaiting approval |
| `/work/.specify/skills/` | active skills replayed each run |
| `/work/reports/` | per-run JSON reports (file sink) |

Resize the PVC with `pvc_size`; the daemon never deletes anything.
