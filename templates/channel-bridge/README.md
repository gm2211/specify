# Bridging Claude Code channels to `specify daemon`

This guide wires **incoming messages from Telegram / Discord / iMessage / any
Claude Code channel** to a running `specify daemon` so you can trigger
verification, capture, or freeform tasks from a chat window.

## Architecture

```
Telegram msg  ─▶  Claude Code (--channels plugin:telegram)  ─▶  specify MCP
                                                               ▼
                                                       specify daemon  (HTTP)
                                                               ▼
                                                       Agent SDK verify run
                                                               ▼
                                                       Reply back via channel
```

The daemon is idle between messages — 0 tokens until something arrives.

## 1. Start the daemon

```bash
specify daemon --port 4100
# → writes ~/.specify/daemon.token on first start
```

Leave it running (e.g. under `launchd`, `systemd`, `tmux`, or `nohup`).

## 2. Register Specify MCP with Claude Code

Add to `~/.claude.json` (or your per-project `.mcp.json`):

```json
{
  "mcpServers": {
    "specify": {
      "command": "specify",
      "args": ["mcp"],
      "env": {
        "SPECIFY_DAEMON_URL": "http://127.0.0.1:4100"
      }
    }
  }
}
```

`specify mcp` auto-reads the token from `~/.specify/daemon.token`. For
remote daemons set `SPECIFY_INBOX_TOKEN` as well.

## 3. Install a channel plugin (official Anthropic plugins)

```bash
claude
/plugin marketplace add anthropics/claude-plugins-official
/plugin install telegram@claude-plugins-official
/telegram:configure <bot-token>
```

## 4. Launch Claude Code with channels enabled

```bash
claude --channels plugin:telegram@claude-plugins-official
```

Pair your account on first Telegram message, then lock down:

```
/telegram:access policy allowlist
```

## 5. Direct the agent

Send a message in Telegram:

> Verify `~/projects/my-app/spec.yaml` against http://localhost:3000

Claude Code will:

1. Receive the channel event in-session.
2. Call the `daemon_verify` MCP tool with `{ spec, url }`.
3. The tool POSTs to `http://127.0.0.1:4100/verify`.
4. Daemon enqueues the message, spawns a fresh Agent SDK run.
5. When it completes, Claude Code replies back through Telegram.

## Tools exposed by `specify mcp`

| Tool | Purpose |
|------|---------|
| `daemon_verify` | Shortcut: `{ spec, url }` → `/verify` |
| `daemon_submit` | Generic: any task → `/inbox` |
| `daemon_status` | Poll `/inbox/:id` for state + result path |

## Direct HTTP (no MCP, no Claude Code)

Any agent — curl, Python, another LLM — can hit the inbox:

```bash
TOKEN=$(cat ~/.specify/daemon.token)

curl -s -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"spec":"/abs/path/spec.yaml","url":"http://localhost:3000"}' \
     http://127.0.0.1:4100/verify
# → {"id":"msg_ab12","status":"queued","stream":"/inbox/msg_ab12/stream"}

# Stream progress
curl -N -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:4100/inbox/msg_ab12/stream

# Poll final result
curl -s -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:4100/inbox/msg_ab12
```

The `resultPath` field on the completed message points to the on-disk
`verify-result.json` (same shape as `specify verify` emits).

## Persistent sessions (attach mode)

Chat-style: keep context across messages from the same sender.

```bash
curl -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"task":"freeform","prompt":"browse http://localhost:3000 and tell me what you see","mode":"attach","session":"chat-alice"}' \
     http://127.0.0.1:4100/inbox

# Follow-up message — same session, agent keeps its browser + memory
curl -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"task":"freeform","prompt":"now click the Settings nav item","mode":"attach","session":"chat-alice"}' \
     http://127.0.0.1:4100/inbox

# Close when done
curl -H "Authorization: Bearer $TOKEN" -X POST \
     http://127.0.0.1:4100/sessions/chat-alice/close
```

In attach mode the daemon still consumes 0 tokens while waiting between
messages — the SDK blocks on the injector's `AsyncIterable`.
