# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

See the Quick Reference in Beads Issue Tracker below. Also available:
`bd update <id> --status in_progress` (alternate claim syntax) and `bd sync` (sync with git).

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and
commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until
`git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

## Landing the Plane (Session Completion)

Same mandatory workflow as **Session Completion** above. Step 4 may alternatively run `bd sync`
instead of `bd dolt push`.

## Build & Test

Run `npm ci`, `npm run quality`, and `npm test`. Build with `npm run build`.

## Architecture and scope

Specify owns behavioral contracts, stable IDs, structural linting, deterministic context projection,
and external results/evidence mapping. External coding agents and test tools own execution.
`src/spec` contains contract tooling, `src/results` validates external results, `src/report` renders
static evidence, and `src/adapters` contains the caller-owned Playwright compatibility adapter.
`src/mcp` exposes authoring tools over stdio only.

Keep `specify.spec/` up to date whenever supported behavior changes. Preserve stable IDs for
retained behavior; remove promises for deleted features. Do not reintroduce a bundled agent, daemon,
learning system, or deployment stack. See `docs/migration-0.3.md` for compatibility and evidence
boundaries.

<!-- specify:begin:intent-workflow -->

## Specify intent workflow

Run commands from the repository root. The tracked intent pack is "specify.intent".

1. Before work, run
   `./specify intent context --pack 'specify.intent' --query "task words" --paths "src/relevant/"`.
   Read global decisions and applicable intent. No search result is proof that no other constraint
   applies.
2. Capture durable user instructions immediately, including conversations with no code change:
   `./specify intent capture --pack 'specify.intent' --input -` accepts a JSON record on stdin.
   Records require id, statement, kind (decision/assumption/proposal), source.text (exact wording),
   and appliesTo (repository-relative files or directory prefixes; [] means global). Preserve
   source.reference when available. Never invent a quotation or promote a proposal or assumption.
   User approval may reference the approved proposal; retain both sources in the wording/reference.
3. Keep records focused. Edit existing records through normal file edits and Git; retain stable IDs.
   Use supersedes only for an explicit replacement decision. Keep superseded records for history.
   Link behaviorIds when an executable contract exists. Keep behavioral contracts organized by area.
   Update intent when intent changes; unchanged behavior needs no artificial spec edit.
4. Before finishing, choose the task's original base commit or PR base SHA and run
   `./specify intent check --pack 'specify.intent' --base BASE` to discover changed files and
   missing review. Review every changed file against relevant intent. Write a review with summary
   and files entries containing path, intentIds, outcome (preserved/changed/unmet/none), and reason.
   Use none with [] only when no intent applies; explain why. Other outcomes require existing intent
   IDs. `./specify intent reconcile --pack 'specify.intent' --base BASE --input -` saves the JSON
   review from stdin. Then run `./specify intent check --pack 'specify.intent' --base BASE`. Rerun
   reconciliation after further edits.
5. Commit the intent records and review with the change. Handoff names changed intent and remaining
   gaps. Never weaken requirements to match implementation. Record unmet intent honestly; the
   completion gate fails.

This is process evidence, not proof of semantic fidelity or test execution. Run appropriate tests
separately. Git/CI checks only see files; agents must capture conversation intent themselves. No
transcript watcher is installed.

<!-- specify:end:intent-workflow -->
