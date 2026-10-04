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

Specify owns behavioral contracts, stable behavior IDs, behavior source attribution, structural
linting, deterministic context projection, and checks of explicitly linked Quint and Lean models.
Agent guidance covers intent capture, conflict review, and code/test reconciliation. Agents perform
semantic review; Specify does not observe conversations or certify implementation correctness.
Formal checks establish results about the authored models only; they do not establish that a model
captures prose faithfully or that an application satisfies it. External coding agents implement
behavior and test runners execute application tests. `src/spec` contains contract tooling; `src/mcp`
exposes five authoring tools over stdio. Specify does not provide an intent ledger, application test
runner, report pipeline, or deployment stack.

Keep `specify.spec/` current whenever supported behavior changes. Preserve IDs for retained behavior
and remove promises for deleted features. See `docs/migration-0.4.md` for compatibility boundaries.

<!-- specify:begin:spec-workflow -->

## Maintain specs as you work

Canonical spec: "specify.spec". Run commands from "." relative to this file.

- Read relevant spec areas and global constraints before editing. Use `./specify spec guide` for
  structure and its capture, review, and reconcile workflow.
- Record explicit user decisions directly in the spec, even when no code changes. Keep stable
  behavior IDs; store exact quotations in source.text and a reference when available. Label
  proposals and assumptions in prose; never promote guesses into requirements.
- Keep one feature per area, short behavior descriptions, and detail in details/prose. Use
  `./specify spec split --spec 'specify.spec'` for oversized single-file specs.
- Update specs when intent changes. Never rewrite requirements to excuse incomplete implementation.
  Report unmet requirements in the handoff and issue tracker.
- Before implementation, review new intent against relevant behaviors, global constraints, and
  existing plans/tasks. Cite conflicting IDs and sources; resolve authorized changes, surface
  unresolved decisions, and continue independent work. This is agent review, not a semantic check
  performed by Specify.
- After implementation, reconcile affected and potentially regressed behavior IDs against current
  code and actual smoke/regression results, including the original bug reproduction. Report each as
  satisfied, gap, or unverified with evidence and revision. Add corrective work to the existing
  tracker, implement authorized fixes, and repeat; never use checked tasks or passing formal models
  as application proof.
- Keep the selected spec authoritative. Plans/tasks reference behavior IDs; do not create duplicate
  requirements or a separate evidence store. Put command/results and blockers in the existing PR or
  task tracker. Do not declare completion with unmet requirements or missing required verification.
- Before finishing, run `./specify spec check --spec 'specify.spec' --base BASE`. Use the task start
  commit or PR base. If intent is unchanged, pass
  `--reason 'why existing requirements still cover this change'` instead of making a token spec
  edit. Include that explanation in the PR.
- Run project tests separately. This check enforces spec lint and a recorded review reason or source
  change, not semantic correctness or execution proof.
- For properties linked from behaviors, run `./specify formal check --spec 'specify.spec'` with
caller-installed Quint or Lean. A passing model check does not establish that the model captures
prose or that the application satisfies it.
<!-- specify:end:spec-workflow -->
