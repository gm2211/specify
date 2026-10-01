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
