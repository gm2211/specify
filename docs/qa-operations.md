# Optional QA operations

Start with the [contract → verify → review workflow](../README.md). These interfaces are optional;
they do not make agent verdicts authoritative or establish better bug detection than a
general-purpose agent.

## Memory and feedback

Specify is more than a one-shot verifier. Verification runs can read and write state under
`<spec_dir>/.specify/`:

```
.specify/
  memory/<spec_id>/<target_key>.json   # learned rows: quirks, playbooks, observations
  sessions.db                          # SQLite + FTS5 transcripts of every session
  confidence.json                      # accept/override tally per behavior
  specify.observations.yaml            # per-spec observations (user feedback + reflection)
  skill-drafts/<id>.md                 # optional learned-skill drafts
  skills/<name>/SKILL.md               # approved skills, replayed when enabled
  verify/verify-result.json            # latest agent run result
```

**Memory rows** ([`src/agent/memory-provider.ts`](../src/agent/memory-provider.ts),
[`src/agent/memory.ts`](../src/agent/memory.ts)) persist across runs, scoped strictly by
`(spec_id, target_key)` so staging and prod never cross-contaminate. The agent injects them into the
next prompt as a preamble; subsequent runs read/update via `memory_record` + `memory_list` MCP
tools.

**Three context layers** ([`src/agent/memory-layers.ts`](../src/agent/memory-layers.ts)) are merged
into every system prompt: user (`~/.specify/memory.md`), project (`SPECIFY.md` or `CLAUDE.md`), and
per-spec (`specify.observations.yaml`). Missing layers are silently skipped.

**Sessions store** ([`src/agent/session-store.ts`](../src/agent/session-store.ts)) indexes every
event in SQLite with FTS5 so the agent (and you) can search prior runs by content.

**Confidence model** ([`src/agent/confidence-store.ts`](../src/agent/confidence-store.ts)) tallies
accept vs override per behavior id. Feedback counts inform confidence-based routing. They are not
calibrated probabilities that a verdict is correct. In `verify --mode auto`, high-confidence
behaviors with an existing generated test and a last passing result can use the scripted tier; other
behaviors go to the agent.

**Pattern miner → skill drafts** ([`src/agent/pattern-miner.ts`](../src/agent/pattern-miner.ts),
[`src/agent/skill-synthesizer.ts`](../src/agent/skill-synthesizer.ts)) is experimental and disabled
by default. Set `SPECIFY_ENABLE_LEARNED_SKILLS=true` to expose draft review endpoints and inject
approved `.specify/skills/<name>/SKILL.md` entries into future runs.

**Optional dialectic provider** ([`src/agent/honcho-provider.ts`](../src/agent/honcho-provider.ts))
— when `HONCHO_URL` is set, an external dialectic user-model service is used instead of the
file-backed memory provider. Optional env vars: `HONCHO_APP` (default `specify`), `HONCHO_USER`
(default `$USER`), `HONCHO_TOKEN`. Without those vars, Specify uses the file-backed provider.

## Cooperative QA via the review webapp

`specify review --spec app.spec.yaml` boots a Hono server with a React UI. The UI subscribes to a
WebSocket of agent events and lets you flag rows inline.

Each flag is one of: `note`, `important_pattern`, `missed_check`, `false_positive`,
`ignore_pattern`, `file_bug`. Behaviour ([`src/agent/feedback.ts`](../src/agent/feedback.ts)):

- writes an observation into `specify.observations.yaml` with `source: user_feedback` and the
  originating session id
- updates the confidence store (`important_pattern` / `file_bug` reinforce; `missed_check` /
  `false_positive` / `ignore_pattern` override)
- on `file_bug`, best-effort spawns `bd create` if available
- when `SPECIFY_ENABLE_LEARNED_SKILLS=true`, `important_pattern` feedback can prompt the active
  agent to apply the same check to sibling behaviors

When `SPECIFY_ENABLE_LEARNED_SKILLS=true`, skill drafts can be reviewed in a dedicated panel.

## MCP — use Specify from any LLM

```bash
# Local (stdio)
specify mcp

# Remote (HTTP)
specify mcp --http --port 8080
```

Claude Desktop / Cursor / Claude Code config:

```json
{ "mcpServers": { "specify": { "command": "specify", "args": ["mcp"] } } }
```

Tools exposed include spec authoring helpers and bridge tools for the daemon (`daemon_verify`,
`daemon_submit`, `daemon_status`).

## Daemon — background agent

Run Specify as a long-lived background process. Idle = 0 tokens. Other agents (or chat bots,
webhooks, CI runners) push jobs into an HTTP inbox; each job spawns an Agent SDK run, streams
progress, and writes its structured result to disk.

```bash
specify daemon --port 4100
# → listens on 127.0.0.1:4100
# → writes a bearer token to ~/.specify/daemon.token on first start
```

Submit a verify job from any agent:

```bash
TOKEN=$(cat ~/.specify/daemon.token)

curl -s -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"task":"verify","prompt":"Verify http://localhost:3000 against the spec.","spec":"/abs/path/spec.yaml","url":"http://localhost:3000"}' \
     http://127.0.0.1:4100/inbox
# → {"id":"msg_ab12","status":"queued","stream":"/inbox/msg_ab12/stream"}

# Stream agent events for this message (SSE)
curl -N -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:4100/inbox/msg_ab12/stream

# Poll the final result (includes path to on-disk verify-result.json)
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:4100/inbox/msg_ab12
```

**Endpoints** (all require `Authorization: Bearer <token>` except `/health`):

| Method | Path                  | Purpose                                                 |
| ------ | --------------------- | ------------------------------------------------------- |
| GET    | `/health`             | Liveness + active session count                         |
| POST   | `/inbox`              | Generic: `{task, prompt, spec?, url?, mode?, session?}` |
| GET    | `/inbox`              | Recent messages                                         |
| GET    | `/inbox/:id`          | Status + result + `resultPath`                          |
| GET    | `/inbox/:id/stream`   | SSE stream of agent events                              |
| GET    | `/events/stream`      | SSE stream of all daemon events                         |
| GET    | `/sessions`           | Active persistent sessions                              |
| POST   | `/sessions/:id/close` | Close a persistent session                              |

**Dispatch modes:**

- `stateless` (default) — fresh SDK run per message, bounded cost. Concurrent jobs run in forked
  worker processes up to `--max-workers` (default 2), each with its own Playwright/Chromium.
- `attach` — injects into a persistent SDK session keyed by `session`. Holds context across
  messages; idle still uses 0 tokens. Always in-process, serial per session.

**Live inspector:** `GET /` on the daemon serves a zero-build HTML page that streams agent events,
lists recent messages, and shows structured results. Prompts for the token on first load.

## Deploy as a QA agent in Kubernetes

Specify ships a container image and a Terraform module so it can run as a long-lived QA agent inside
a cluster. One pod per spec, PVC-backed memory that survives restarts, and pluggable triggers (k8s
informer, webhook, or both).

```hcl
module "qa" {
  source = "github.com/gm2211/specify//deploy/terraform/modules/specify-qa?ref=main"

  name      = "renzo-qa"
  namespace = "qa"

  target_url  = "http://renzo.app.svc.cluster.local:8080"
  spec_inline = file("${path.module}/specify.spec.yaml")

  discovery = { mode = "watch", namespaces = ["app"] }

  report_slack_webhook     = var.slack_webhook_url
  anthropic_api_key_secret = "anthropic-api-key"
}
```

| Group     | Pick exactly one                                                            |
| --------- | --------------------------------------------------------------------------- |
| Target    | `target_url` · `target_dns` · `target_cluster_ip` · `target_from_configmap` |
| Spec      | `spec_inline` · `spec_url` (+ optional bearer) · `spec_git`                 |
| Discovery | `webhook` (default) · `watch` · `both` · `none`                             |
| Reports   | `report_file_dir` (default) + optional `report_slack_webhook`               |

**Self-describing install for agents.** `specify deploy describe --format=json` emits a structured
manifest: image coordinates, module ref, oneof groups, required Secrets, outputs, and an
`agent_install_recipe`. Drop `specify deploy print-tf <preset>` into a consumer repo for a working
`.tf` skeleton (`minimal`, `watch-mode`, `webhook-mode`, `gitops-spec`).

```bash
specify deploy describe --format=json | jq .
specify deploy print-tf watch-mode > specify-qa.tf
```

**Worked examples** live in [`deploy/terraform/examples/`](../deploy/terraform/examples):
[`minimal`](../deploy/terraform/examples/minimal),
[`watch-mode`](../deploy/terraform/examples/watch-mode),
[`gitops-spec`](../deploy/terraform/examples/gitops-spec). Each example is a runnable
`terraform apply` directory with a per-example README.

The pod's `/work` PVC keeps everything the daemon learns:

| Path                                            | Content                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `/work/.specify/memory/<spec_id>/<target>.json` | learned memory rows                                              |
| `/work/.specify/sessions.db`                    | session SQLite + FTS5                                            |
| `/work/.specify/skill-drafts/`                  | optional learned-skill drafts                                    |
| `/work/.specify/skills/`                        | active skills replayed when `SPECIFY_ENABLE_LEARNED_SKILLS=true` |
| `/work/reports/`                                | per-run JSON reports (file sink)                                 |

See
[`deploy/terraform/modules/specify-qa/README.md`](../deploy/terraform/modules/specify-qa/README.md)
for the full input / output reference.
