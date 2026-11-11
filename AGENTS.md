# Agent Instructions

## Issue tracking

Tasks are GitHub Issues, managed with the `gh` CLI:

```bash
gh issue list                                       # Find open work
gh issue create --title "..." --body "..."          # File a task
gh issue close <n> --comment "Completed in #<pr>"   # Complete work
```

For follow-up work discovered along the way, file a new issue and reference the parent issue number
(for example "Follow-up to #12") in the body.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until
`git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create GitHub Issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished issues, comment on in-progress ones
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
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

## Merging

Agents may merge their own PRs in this repository once CI is green and no review threads are open,
without asking first (Giulio, 2026-11-04: "do it all, merge without asking for specify").

## Build & Test

Run `npm ci`, `npm run quality`, and `npm test`. Build with `npm run build`. With Quint on PATH,
`./specify gate --format text` gates this repository (write the test report first, as CI does:
`mkdir -p reports && npm test -- --test-reporter=junit --test-reporter-destination=reports/junit.xml`),
and `./specify formal check --root examples/counter --tool quint` runs the example end to end.

## Architecture and scope

Specify is a spec-driven development gate for [OpenSpec](https://github.com/Fission-AI/OpenSpec).
OpenSpec owns the spec format, change proposals, validation and browsing. Specify owns:

- `src/formal/`: reading `Formal:` and `Verify:` lines under OpenSpec requirements (`openspec.ts`),
  running Quint (TLC, Apalache, simulation) and Lean (`quint.ts`, `lean.ts`, `process.ts`), and the
  requirement → result report (`check.ts`, `report.ts`).
- The gate (`gate.ts`): one verdict over the checks, the coverage policy (`policy.ts`, `config.ts`),
  test reports for `Verify:` lines (`verify.ts`), and the drift lock (`lock.ts`, `git.ts`).
  `trace.ts` extracts counterexamples and exports ITF traces.
- `src/init/` and `src/cli/commands/init.ts`: `specify init` runs `openspec init`, creates `formal/`
  and its policy file, manages one AGENTS.md region, and installs the Claude Code Stop hook and a
  pre-push hook (`hooks.ts`).

Formal checks establish results about the authored models only; they do not establish that a model
captures the prose or that an application satisfies it. Specify reads the test reports a project's
own test run wrote; it does not run application tests.

Specify's own requirements live in `openspec/specs/`. Update them whenever supported behavior
changes, record explicit user decisions with their exact wording in `product-direction`, and run
`npx @fission-ai/openspec validate --specs --strict`. See `docs/migration-0.8.md` for what was
removed in 0.8.

This repository gates itself under the `strict` policy. Its models are in `formal/` (`Overlay.qnt`,
`Verdict.qnt`, `ManagedRegion.qnt`), each with a before model, and `src/formal/conformance.test.ts`
replays the traces in `formal/traces/` against the code. After changing a model run
`./specify trace export`, and after changing links or properties run `./specify lock`; commit both.
CI runs the gate on the repository root and on `examples/counter`.

<!-- specify:begin:formal-workflow -->

## Formal properties (Specify)

OpenSpec (`openspec/`) holds the requirements. Specify checks the formal models linked to them and
gates the work on the result.

- Link a model under the `### Requirement:` it encodes, one list item per check (formatters join
  plain lines):
  - `- Formal: quint formal/<model>.qnt <property> [invariant|temporal] [expect=holds|fails] [backend=tlc|apalache] [main=<module>]`
  - `- Formal: lean formal/<File>.lean <Namespace.theorem>`
  - `- Formal: none (<reason>)` waives a requirement that should not be modeled, such as pure
    input/output behavior.
- Paths are relative to the project root. Keep models and proofs in `formal/`.
- For every Quint property that must hold, link the same property on a "before" model or mutation
  with `expect=fails`, so a property that can never fail is caught.
- Write liveness as a temporal property with fairness (`weakFair`). TLC is the default backend and
  explores every reachable state within the model's constants; `backend=apalache` is bounded by
  `max-steps`.
- Tie each model to the code: write a conformance test that replays the traces from
  `./specify trace export` against the implementation, and name it under the requirement with
  `- Verify: test <test name>`. Specify reads the test reports listed in `formal/specify.json`; it
  does not run tests.
- Run `./specify gate` before finishing. Under the `strict` policy it fails when a check differs
  from its expectation, a requirement has neither a link nor a waiver, a property has no
  `expect=fails` link, a `Verify:` test is missing or red, or `formal/specify.lock` is out of date.
- After changing links or properties, run `./specify lock` and commit `formal/specify.lock`.
  Removing a link, flipping `expect` or editing a linked property needs an OpenSpec change proposal
  that names the requirement; never do it just to make a check pass.
- A passing check is a statement about the model only.
<!-- specify:end:formal-workflow -->
