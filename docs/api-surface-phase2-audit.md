# API Surface Phase 2 Audit

Baseline: `origin/main` at PR #33 (`076173b`). No checked-in `.specify/` run artifacts or skill drafts were present, so evidence is from source, tests, README, templates, and deploy docs.

| Surface | Verdict | Evidence |
| --- | --- | --- |
| `specify replay` task + CLI command | GATE | Implemented in `src/cli/index.ts`, `src/daemon/inbox.ts`, `src/mcp/tools.ts`, and `src/agent/prompts.ts`, but only advertised by README/spec and has no dedicated daemon/CLI tests or checked-in replay artifacts. |
| `specify compare` task + CLI command | KEEP | README lists it as a primary command; runner has dual-browser handling and structured `match/diffs` output; prompt tests cover compare prompt shape. |
| `specify clean` | KILL | Already removed by PR #33 from manifest and CLI; remaining generated state is under `.specify/`, so `rm -rf .specify/` is equivalent. |
| Daemon `freeform` task | KEEP | Channel bridge template uses `freeform` attach sessions for chat-driven inspection, and daemon/inbox tests cover `freeform` dispatch. |
| `specify create` vs `specify human` chat | KEEP | `create` writes a starter spec from fixed prompts; `human` is a REPL for load/verify/capture/review and does not create a spec. |
| Daemon `GET /sessions` + `POST /sessions/:id/close` | KEEP | Live inspector polls `/sessions`, and the channel bridge docs use `/sessions/:id/close` to end attach-mode chat sessions; both routes remain bearer-protected. |
| `memory-layers.ts` vs `memory-provider.ts` | KEEP | `memory-layers` loads prompt context from user/project/per-spec observation files; `memory-provider` abstracts learned-memory storage and MCP writes. Both are separately tested and both feed `sdk-runner`. |
| `pattern-miner` + `pattern-propagator` + `skill-synthesizer` chain | GATE | `minePatterns` has no production caller and no real output artifacts were present; skill draft endpoints/active skill injection and sibling-check propagation now require `SPECIFY_ENABLE_LEARNED_SKILLS=true`. |

No new KILL verdict needs a fresh cut PR from this audit; `specify clean` was already cut in PR #33.
