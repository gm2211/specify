---
name: deep-review
description: >
  Holistic review-fix loop: self-review then fix then re-review until clean,
  followed by the same loop but with Codex as reviewer. Catches both
  implementation bugs and product-level gaps.
user-invocable: true
---

# Deep Review — Iterative review-fix loop

Run a two-phase review-fix loop on the current uncommitted changes until nothing is left to fix.

## Phase 1: Self-review loop

Repeat until no issues found:

1. **Review holistically** — not just the diff, but the system. Use an Explore agent to read all changed files AND the files they interact with. Ask:
   - Does the code do what the product intends?
   - Are exit codes semantically correct?
   - Are error paths reachable and properly handled?
   - Are all advertised features actually wired up?
   - Do prompts/schemas/docs match the runtime?
   - Are there resource leaks, type unsoundness, or dead code paths?
   - Are interactive surfaces (TUI, REPL, wizard) consistent with the new code?

2. **Fix all issues found** — apply changes, run `npm test`, confirm all pass.

3. **Re-review** — if the review found issues, go back to step 1 after fixing. Only stop when the review says "No issues found."

## Phase 2: Codex review loop

After the self-review loop converges, repeat with Codex as the reviewer:

1. **Send to Codex** via `mcp__codex__codex` with:
   - `sandbox: "read-only"`
   - `cwd` set to the repo root
   - `approval-policy: "never"`
   - Prompt asking Codex to read all relevant source files (not just diffs) and find bugs — incorrect behavior, crashes, wrong results, resource leaks, type errors, stale docs, dead code. Cite file:line for every claim.

2. **Fix all issues Codex found** — apply changes, run tests.

3. **Re-send to Codex** — ask it to verify fixes and find remaining issues. Only stop when Codex says "No issues found" or only reports accepted design limitations (not bugs).

## Key principles

- **Review the system, not the diff.** A diff review catches regressions. A system review catches "did we build the right thing?"
- **Don't manufacture problems.** Only fix real bugs with file:line evidence.
- **Draw the line.** When the reviewer starts finding pre-existing feature gaps unrelated to the current work, stop.
- **Run tests after every fix.** Never skip this.
- **Accepted limitations are OK.** Document them and move on — not every finding needs a code fix.

## Invocation

```
/deep-review
```

No arguments needed. Works on whatever is uncommitted in the current worktree.
