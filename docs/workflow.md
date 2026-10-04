# Workflow

The behavioral spec is the authority for product direction. Put accepted decisions in behavior
descriptions, preserve exact user wording in `source.text`, and use stable `area/behavior` IDs. The
source metadata supplements the existing description and optional details; it does not replace them.
Label unresolved assumptions and unapproved proposals plainly in prose; do not turn them into
accepted behavior. Edit the same behavior when direction changes instead of maintaining a separate
decision ledger.

Initialize agent guidance once:

```bash
./specify spec init --spec specify.spec
```

This installs a concise managed block in `AGENTS.md`; `--agents PATH` selects another instructions
file. Existing text outside the managed block remains intact. When upgrading this repository, init
replaces only the owned legacy intent-workflow block.

Example behavior:

```yaml
- id: keep-export-format
  description: Existing exports remain readable by the current importer.
  source:
    text: Keep existing customer exports importable during the redesign.
    reference: issue-42
```

Before finishing, lint the spec and account for repository changes:

```bash
./specify spec check --spec specify.spec --base "$BASE"
```

If repository files changed but the spec did not, provide a concise reason:

```bash
./specify spec check --spec specify.spec --base "$BASE" \
  --reason "Refactored internal code without changing accepted behavior."
```

`BASE` is the task's starting commit or pull request base. Check validates the selected spec and
requires either a changed spec source or a nonblank `--reason` when other repository files changed.
It does not claim that implementation matches the spec or that tests ran; use your test runner for
execution evidence. In pull requests to this repository, put a reason on its own line as
`Spec review: <reason>` when the spec did not change; CI passes that first matching line to check.

No hook is installed automatically. A local hook can run one command, using the target branch's
merge base:

```sh
./specify spec check --spec specify.spec --base "$(git merge-base HEAD origin/main)"
```

## Capture, review, reconcile

`spec guide` and the MCP `get_authoring_guide` tool expose the same `workflow` protocol. `spec init`
installs its entry points in the agent instructions. Run initialization again to update an existing
managed block; hand-written instructions outside it remain untouched.

1. **Capture during conversation.** Record an explicit decision in the relevant behavior, even if no
   code changes. Preserve exact source wording and the existing ID. Report where the decision
   landed. Resolve authorized changes to prior intent; surface unresolved conflicts with both
   sources.
2. **Review before implementation.** Compare the request and plan against relevant behaviors and
   global constraints, including other areas. Give source-linked conflict, ambiguity, and coverage
   findings. The review itself changes neither requirements nor code.
3. **Reconcile after implementation.** Compare affected and potentially regressed behaviors with
   current code, original bug reproductions, and real smoke/regression results. Report each behavior
   as `satisfied`, `gap`, or `unverified`, with revision, code locations, command/results, and
   evidence. Track corrections in the existing issue tracker, implement authorized fixes, and
   repeat.

For example, if `exports/old-files-readable` requires backward compatibility, a passing lint check
does not establish it. Run the existing importer against representative old files. A rejected old
file is a gap; an unavailable importer is unverified. A passing formal model or unrelated test suite
cannot turn either into satisfied.

Keep plans and task records focused on implementation and references to behavior IDs. Keep evidence
in the existing PR or task record. Neither needs another copy of the requirements. Proposals remain
proposals until accepted; changing code does not authorize changing intent.

These steps depend on the calling agent following instructions. Specify does not monitor arbitrary
conversations or mechanically detect semantic conflicts. `spec check` still validates structure and
recorded review; it does not certify the agent's findings or test coverage. Required missing
evidence must remain visible in the handoff.

For optional GitHub Spec Kit command integration, see [the adapter guide](spec-kit.md).
