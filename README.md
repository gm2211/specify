```

   ███████╗██████╗ ███████╗ ██████╗██╗███████╗██╗   ██╗
   ██╔════╝██╔══██╗██╔════╝██╔════╝██║██╔════╝╚██╗ ██╔╝
   ███████╗██████╔╝█████╗  ██║     ██║█████╗   ╚████╔╝
   ╚════██║██╔═══╝ ██╔══╝  ██║     ██║██╔══╝    ╚██╔╝
   ███████║██║     ███████╗╚██████╗██║██║        ██║
   ╚══════╝╚═╝     ╚══════╝ ╚═════╝╚═╝╚═╝        ╚═╝

   Write specs. Validate behavior. Ship with evidence.

```

Specify turns functional requirements into machine-verifiable specs. Define what your app should do — pages, flows, assertions, API contracts — and Specify tells you what's met, what's not, and what's untested. Every assertion shows its work: expected value, actual value, raw output.

No opinions about your test framework. No lock-in. Just structured truth.

---

<p align="center">
  <img src="assets/demo.svg" alt="Specify CLI demo" width="780"/>
</p>

---

## Install

```bash
npm install
npm run build
```

## Lifecycle

```bash
# 1. Create a contract
specify create                   # interactive interview → spec + narrative

# 2. Capture existing behavior
specify capture --url http://localhost:3000

# 3. Compare remote vs local
specify compare --remote https://prod.example.com --local http://localhost:3000

# 4. Review the contract
specify review --spec app.spec.yaml

# 5. Verify the implementation
specify verify --spec app.spec.yaml --url http://localhost:3000
specify verify --spec app.spec.yaml --capture ./captures
```

## Commands

| Command | What |
|---------|------|
| **`create`** | Interactive interview → spec + narrative |
| **`capture`** | Agent-driven capture from live system (`--url`) or code (`--from code`) |
| **`compare`** | Live side-by-side comparison of remote and local targets |
| **`review`** | Inspect the contract in a browser |
| **`verify`** | Verify against captures (`--capture`) or live (`--url`) |
| `cli run` | Run CLI commands defined in spec, validate output |
| `lint` | Structural validation (no captures needed) |
| `spec export` | Generate Playwright or Cypress tests from spec |
| `spec import` | Import existing e2e tests as spec items |
| `spec sync` | Bidirectional diff: spec vs e2e tests |
| `schema` | Emit JSON Schema for spec, report, or commands |
| `mcp` | MCP server — any LLM client can use Specify as a tool |
| `daemon` | Long-running HTTP inbox; other agents push verify/capture/compare jobs |

## Reports you can trust

Every validation report includes **expected vs actual evidence** for every assertion. No "100% passed, trust me" — you get the raw output, the exact match, and the assertion logic.

Formats: **JSON** (machine), **Markdown** (diff-friendly), **HTML** (interactive, filterable, single file).

```
| Status | Type           | Expected          | Actual                              |
|--------|----------------|-------------------|-------------------------------------|
| ✅     | text_contains  | spec validate     | ..."name": "spec validate", ...     |
| ✅     | json_path      | 0.1.0             | 0.1.0                               |
| ❌     | json_schema    | matches schema    | /items: must have >= 5 items        |
```

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

7 tools exposed: `get_authoring_guide`, `lint_spec`, `validate_spec`, `export_tests`, `list_commands`, `parse_spec`, `spec_to_yaml`.

## Daemon — background agent

Run Specify as a long-lived background process. Idle = 0 tokens. Other agents
(or chat bots, webhooks, CI runners) push jobs into an HTTP inbox; each job
spawns an Agent SDK run, streams progress, and writes its structured result
to disk.

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
     -d '{"spec":"/abs/path/spec.yaml","url":"http://localhost:3000"}' \
     http://127.0.0.1:4100/verify
# → {"id":"msg_ab12","status":"queued","stream":"/inbox/msg_ab12/stream"}

# Stream agent events for this message (SSE)
curl -N -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:4100/inbox/msg_ab12/stream

# Poll the final result (includes path to on-disk verify-result.json)
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:4100/inbox/msg_ab12
```

**Endpoints** (all require `Authorization: Bearer <token>` except `/health`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Liveness + active session count |
| POST | `/verify` | `{spec, url}` shorthand |
| POST | `/capture` | `{url}` shorthand |
| POST | `/inbox` | Generic: `{task, prompt, spec?, url?, mode?, session?}` |
| GET | `/inbox` | Recent messages |
| GET | `/inbox/:id` | Status + result + `resultPath` |
| GET | `/inbox/:id/stream` | SSE stream of agent events |
| GET | `/events/stream` | SSE stream of all daemon events |
| GET | `/sessions` | Active persistent sessions |
| POST | `/sessions/:id/close` | Close a persistent session |

**Dispatch modes:**
- `stateless` (default) — fresh SDK run per message, bounded cost.
  Concurrent jobs run in forked worker processes up to `--max-workers`
  (default 2), each with its own Playwright/Chromium.
- `attach` — injects into a persistent SDK session keyed by `session`.
  Holds context across messages; idle still uses 0 tokens. Always
  in-process, serial per session.

**Live inspector:** `GET /` on the daemon serves a zero-build HTML page
that streams agent events, lists recent messages, and shows structured
results. Prompts for the token on first load. Useful for watching
verify runs in real time from a browser tab.

**Learned memory:** each verify run reads/writes `.specify/memory/<spec>/<target>.json`
via `memory_record` + `memory_list` tools. Playbooks, quirks, and
observations are injected into the system prompt on subsequent runs,
scoped strictly to the same (spec, target) pair so staging and prod
never cross-contaminate.

**MCP bridge:** `specify mcp` exposes `daemon_verify`, `daemon_submit`,
`daemon_status` tools so any LLM client (Claude Code with `--channels`,
Cursor, Claude Desktop) can delegate to the daemon. See
[`templates/channel-bridge/README.md`](templates/channel-bridge/README.md)
for the Telegram / Discord / iMessage setup.

## Spec format

YAML or JSON. Human-readable, machine-verifiable.

```yaml
version: "1.0"
name: "My App"
description: "Behavioral contract for My App"

pages:
  - id: dashboard
    path: /dashboard
    title: "Dashboard"
    visual_assertions:
      - type: element_exists
        selector: "nav.sidebar"
        description: "Navigation sidebar is present"
    expected_requests:
      - method: GET
        url_pattern: "/api/v1/stats"
    scenarios:
      - id: user-login
        description: "User logs in and sees dashboard"
        steps:
          - action: fill
            selector: "#email"
            value: "{{email}}"
          - action: click
            selector: "button[type=submit]"
          - action: wait_for_navigation
            url_pattern: "/dashboard"
          - action: assert_visible
            selector: ".welcome-message"

variables:
  base_url: "${TARGET_BASE_URL}"
```

## Self-verifying

Specify eats its own dogfood. The repo includes `specify.spec.yaml` — a spec for Specify itself — validated on every run. Current status: **178 assertions, 100% coverage, 0 failures.** [See the report →](cli-report/cli-report.md)

## License

GPL-3.0
