# Specify

**Keep a behavioral contract. Check it. Review the evidence.**

Specify gives product requirements stable behavior IDs and connects QA results to those behaviors.
Use its CLI or MCP tools alongside your coding agent, then run its optional QA agent against a live
web, CLI, or API target. Review what passed, failed, or was skipped, together with the observations
recorded during the run.

Its value is a reusable contract and inspectable QA output. Better bug detection than a
general-purpose agent using Playwright is **not established**; the live comparison is currently
blocked on Claude subscription quota. See the
[comparison protocol and results](docs/qa-comparison.md).

## When to reach for it

- While building a feature: agree on its intended behavior and update the contract with the code.
  Keep existing behavior IDs stable so results stay traceable.
- Before shipping: verify the contract against a test environment and inspect failures, missing
  checks, and evidence.
- After deployment: optionally submit the same verification to a background runner.

For a one-off browser check with no contract to maintain, your existing agent and Playwright may be
sufficient. Website recording, cloning, replay, and side-by-side comparison belong to Mockify.

Specify currently has **no code-change impact analysis or feature-dependency graph**. Areas and tags
organize requirements; they do not identify everything a change could break. Its experimental
navigation map describes observed browser transitions, not dependencies between product features.

## Install

```bash
npm install
npm run build
npm --prefix webapp install
npm --prefix webapp run build
```

From this checkout, use `./specify` (it builds on first run). The examples below use that wrapper. A
linked or installed CLI can use `specify` instead.

Live agent runs use the Claude Agent SDK and currently select `claude-opus-4-6`. Configure Claude
authentication (for example, `claude auth login`) or an `ANTHROPIC_API_KEY`, and install the browser
if needed:

```bash
npx playwright install chromium
```

Linting, schema output, and report rendering do not require an LLM. Generated browser tests use
Playwright; this is not a framework-neutral runner.

## Start with intended behavior

Write `app.spec.yaml` and review it with your coding agent:

```yaml
version: '2'
name: Team workspace
description: Members have access appropriate to their role.
target:
  type: web
  url: http://localhost:3000
areas:
  - id: access
    name: Access control
    behaviors:
      - id: viewer-cannot-invite
        description: A viewer cannot invite a new member to the workspace.
        details: Rejection must leave the member list unchanged.
        tags: [permissions]
```

Use a disposable test environment with the required users and data. The agent chooses how to check
each plain-language claim; the spec does not contain selectors, matchers, or step sequences.

```bash
# Check the contract's structure, not whether the application works.
./specify spec lint --spec app.spec.yaml

# Check the live target. Use a distinct output directory for each run.
./specify verify --spec app.spec.yaml --output .specify/runs/check-001

# Inspect behavior results and the agent's account of its checks.
./specify review --spec app.spec.yaml \
  --agent-report .specify/runs/check-001/verify-result.json

# Package that completed run as a self-contained HTML evidence report.
./specify prove --spec app.spec.yaml --input .specify/runs/check-001
```

`prove` documents a run; it does not independently certify the application. It can successfully
render a report for a failed verification.

![Current review UI showing Specify's own contract, before verification](assets/screenshots/review-overview.png)

The screenshot shows the current self-spec with no verification report loaded. “Untested” is
deliberate: a valid contract is not evidence that its behaviors work.

Need help drafting? `./specify create` interviews you, and `./specify spec guide` provides schema
and examples for an agent. `./specify capture --url ...` explores a live app and writes a
**candidate** spec. Review that draft against intended requirements: observing an existing bug must
not make it an accepted requirement.

## What the evidence means

The agent reports a status and may provide evidence, a method, rationale, and an annotated action
trace for each behavior. These are judgments, not automatically proven assertions. The current
output schema does not require evidence for every behavior, so inspect missing evidence as well as
failures.

The runner separately records browser actions, screenshots, and associated observations, or CLI
invocations and their output. `prove` distinguishes:

- **runner-recorded**: evidence matched to the recorded trace or supported scripted output,
  according to the report loader's matching rules;
- **agent-reported**: the agent's account without a matching recorded item.

A recorded screenshot establishes what was captured, not that the agent's entire interpretation is
correct. The HTML report includes source-file hashes and sizes for inspection; those are not
independent attestations.

Verification writes structured JSON. `prove` produces portable HTML; `review` provides an
interactive UI. Keep the spec/code revision and target environment with archived runs when you need
release-level traceability; behavior IDs alone do not establish freshness or revision identity.

## Reuse checks

```bash
# Re-run generated Playwright tests from an existing output directory, no LLM.
./specify verify --spec app.spec.yaml --output .specify/runs/check-001 --mode scripted

# Choose scripted or agent verification per behavior using prior feedback/tests.
./specify verify --spec app.spec.yaml --output .specify/runs/check-001 --mode auto

# Replay generated tests and report disagreement with the agent.
./specify verify --spec app.spec.yaml --output .specify/runs/check-002 --cross-check
```

Generated tests are candidates for review, not guaranteed correct regression coverage. `auto` uses
feedback confidence, test existence, and the last recorded status; it does not analyze your diff or
prove tests are current. Scripted failures escalate to the agent, which can recheck or regenerate
tests. `--cross-check` is report-only: disagreement does **not** change the verification's exit
status. Archive an output directory before reusing it if you need its previous results.

## Interfaces

| Interface                                       | Role                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `spec lint`, `schema`, `spec guide`             | Parse and author contracts                           |
| `create`, `capture`                             | Draft candidate requirements for review              |
| `verify`                                        | Run the bundled QA agent or generated tests          |
| `review`, `prove`                               | Inspect results or package a completed run           |
| `spec split`, `spec context`, `spec migrate-id` | Maintain larger contracts and derived context        |
| `mcp`                                           | Authoring helpers and bridges to a running QA daemon |
| `daemon`                                        | Optional HTTP job runner for CI or other agents      |

Run `./specify <command> --help` or `./specify schema commands` for the complete surface, including
advanced commands.

The public MCP server exposes `get_authoring_guide`, `lint_spec`, `parse_spec`, `spec_to_yaml`,
`list_commands`, event/session helpers, and `daemon_verify` / `daemon_submit` / `daemon_status`.
Calling the daemon delegates to Specify's bundled agent; it does not turn the calling agent's own
browser session into a recorded Specify verification.

## Optional capabilities

- [Large contracts and generated PRODUCT.md / DESIGN.md](docs/large-specs.md).
- `spec lint` warns when a single file exceeds 40 KiB, 800 lines, 12 areas, or 120 behaviors;
  it fails above twice those limits. Use `spec split` to make a directory contract.
- [Feedback, memory, MCP configuration, background jobs, and Kubernetes deployment](docs/qa-operations.md).
- Learned skills, navigation-map coverage, temporal monitors, and Quint models are experimental
  opt-ins. See [feature flags](src/agent/feature-flags.ts). They are not required for the workflow
  above, and none supplies a feature-impact graph.

## Development

```bash
npm run quality  # CLI/UI typecheck, lint, self-spec structural validation
npm test         # automated tests
npm run format   # Prettier check (repository-wide baseline tracked separately)
```

The [self-spec](specify.spec/spec.yaml) describes Specify's public behavior. `npm run validate`
checks its structure; it does **not** run live QA against every self-spec behavior. Optional Sonar
scanning is configured in `sonar-project.properties` (`SONAR_TOKEN` when required).

## License

GPL-3.0
