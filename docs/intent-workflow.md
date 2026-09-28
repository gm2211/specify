# Intent workflow

Intent records preserve why a change matters while code changes. They complement stable behavior
IDs: contracts describe expected behavior, intent records capture the decisions, assumptions, and
proposals that guide work. A coding agent can retrieve relevant records before editing and reconcile
each changed file during review. Specify checks recorded structure and coverage; the user or coding
agent judges whether implementation actually honors intent.

## Initialize a repository

Run from the repository root:

```bash
./specify intent init
```

By default, this creates `specify.intent/records/` and installs a managed instruction block in the
root `AGENTS.md`. It appends the block without replacing existing text and is safe to rerun. Use
`--root DIR` to select another repository root and `--pack DIR` to select another intent pack path.
The default pack is `<root>/specify.intent`.

The installed instructions tell agents to load context before editing, preserve uncertainty as
assumptions or proposals, and reconcile changed files before declaring completion. They do not
require editing contracts on every commit. Capture explicit user direction as a decision; record
uncertain premises as assumptions; keep unapproved options as proposals. Do not weaken a requirement
to match existing code.

## Capture a record

Write a JSON record to a file or stdin. Record IDs use kebab-case. `statement` is limited to 2,000
characters, `source.text` to 8,000 characters, and the formatted record to 16 KiB. Capture validates
the full supersession graph before writing; malformed links or cycles create no record. Record IDs
are create-only: an existing ID is never overwritten. `appliesTo` contains exact repository-relative
file paths or directory prefixes ending in `/`; an empty array means global. `behaviorIds`
optionally links stable `area/behavior` IDs. Use `supersedes` only when an explicit new decision
replaces an earlier record.

```json
{
  "id": "keep-export-format-stable",
  "statement": "Existing exports remain readable by the current importer.",
  "kind": "decision",
  "source": {
    "text": "Keep existing customer exports importable during the redesign.",
    "reference": "issue-42"
  },
  "rationale": "Customers retain archived exports.",
  "appliesTo": ["src/export/", "src/import/legacy.ts"],
  "behaviorIds": ["exports/import-legacy-format"],
  "supersedes": []
}
```

```bash
./specify intent capture --input intent-record.json
# Or, instead, read one record from stdin:
cat another-intent-record.json | ./specify intent capture --input -
```

Capture creates a record and never overwrites one with the same ID. Update records through the
repository's editor and Git history, and commit records with the code they guide. Decisions,
assumptions, and proposals remain distinct; a proposal does not become a decision merely because
code implements it.

## Retrieve context before work

```bash
./specify intent context --query "legacy export compatibility"
./specify intent context --paths src/export/writer.ts,src/import/legacy.ts
```

Query terms are tokenized; a record matches when all query terms occur in its searchable fields.
When both query and paths are supplied, a query match or a path match is enough. Path matching
supports exact files and directory-prefix overlap. Context always includes global decisions. Output
keeps kinds distinct. A prior decision is excluded as superseded only when an explicit superseding
decision names it. An assumption or proposal does not silently replace a decision.

## Reconcile a change

After implementation, choose an explicit base commit or ref. For a pull request, use its base SHA.
Discover the changed paths and fingerprint first:

```bash
./specify intent check --base "$PR_BASE_SHA"
```

Stage the complete intended change before checking. Partially staged files are rejected. The check
reports the snapshot and any missing or invalid review. Reconcile input must account for every
changed tracked or untracked file in that snapshot, with no extras. The review is bound to the
resolved base SHA and file fingerprint, so changing the file set or content invalidates the prior
review.

```json
{
  "summary": "Preserved export compatibility while simplifying the writer.",
  "files": [
    {
      "path": "src/export/writer.ts",
      "intentIds": ["keep-export-format-stable"],
      "outcome": "preserved",
      "reason": "Writer retains the established field names and encoding."
    },
    {
      "path": "docs/contributing.md",
      "intentIds": [],
      "outcome": "none",
      "reason": "Contributor documentation has no applicable scoped intent record."
    }
  ],
  "unmet": []
}
```

Allowed outcomes are `preserved`, `changed`, `unmet`, and `none`. `none` requires no intent IDs;
other outcomes require one or more IDs. Use `unmet` with a reason when a record is not satisfied;
any unmet item fails the gate. `intent reconcile` writes `<pack>/review.json`.

```bash
# Keep input outside the repository snapshot. Reconcile writes the durable pack/review.json.
./specify intent reconcile --base "$PR_BASE_SHA" --input /tmp/intent-review.json
./specify intent check --base "$PR_BASE_SHA"
```

Every changed file must name each applicable active decision in `intentIds`, or identify that
decision in the top-level `unmet` array with a reason. Assumptions and proposals may be included
when relevant but are optional. `outcome: "none"` cannot bypass an applicable decision. Any
top-level unmet entry or file outcome of `unmet` fails the gate.

Commit `specify.intent/review.json` together with reviewed changes. The review file is excluded from
its own snapshot, while records and all other changed files remain covered. This keeps review
evidence available after clone and lets CI check the same base and content fingerprint.

## CI and Git hook examples

Pass the actual merge base explicitly. In CI, set `PR_BASE_SHA` from the pull request's base commit;
do not rely on a moving branch name. `intent init` does not install hooks. Add the check explicitly
to your CI or hook; the Specify repository wires it into its own CI. To prepare a review, inspect
the snapshot from the first check, create `/tmp/intent-review.json` for those files, then run:

```bash
./specify intent check --base "$PR_BASE_SHA"
./specify intent reconcile --base "$PR_BASE_SHA" --input /tmp/intent-review.json
./specify intent check --base "$PR_BASE_SHA"
```

For a local pre-commit hook, resolve the merge base against the target branch and invoke the same
check. A hook can require a current review, but should not invent semantic outcomes:

```sh
base=$(git merge-base HEAD origin/main) || exit 1
./specify intent check --base "$base"
```

Neither integration watches transcripts or runs as a daemon. Hooks enforce that records and review
coverage exist and match the snapshot. They cannot prove that a rationale is honest, that a
requirement was implemented correctly, or that tests ran. Pair this gate with contract lint and
external test/result checks where appropriate.

## MCP

The local stdio server exposes `initialize_intent`, `capture_intent`, `get_intent_context`,
`reconcile_intent`, and `check_intent_review` wrappers over the same core operations as the CLI.
Five existing contract-authoring tools remain available. MCP and CLI apply the same validation and
review rules; neither provides an agent or executes code.
