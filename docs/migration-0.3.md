# Migrating to Specify 0.3

Version 0.3 reduces Specify to behavioral contracts, stable IDs, structural linting, deterministic
context projection, and external results/evidence mapping. This is a breaking scope reduction.

## Retained interfaces

- v2 YAML/JSON contracts, composed directory specs, and `area/behavior` IDs.
- `spec lint`, `spec split`, `spec guide`, `spec context`, and schema introspection.
- `prove`, reading `verify-result.json` directly or under the legacy `structuredOutput` wrapper,
  plus legacy observation/screenshot files and optional recorded metadata.
- Five authoring MCP tools over local stdio: `get_authoring_guide`, `lint_spec`, `parse_spec`,
  `spec_to_yaml`, and `list_commands`.
- `verify --mode scripted --spec <contract> --output <suite-dir>` for existing callers such as
  Argos. This thin adapter invokes the caller's installed Playwright CLI and maps test titles to
  contract IDs. It does not generate tests, install dependencies, or own browser execution.

## New verification boundary

Run tests with your preferred tooling and emit a JSON object containing `results`, with one entry
per checked `area/behavior` ID and status `passed`, `failed`, or `skipped`. Description is taken
from the contract. Optional evidence records use `type`, `label`, and `content`.

Use `verify --spec <contract> --report results.json`. Missing and skipped IDs fail the full-contract
gate with exit 2. Failed assertions exit 1; invalid input exits 10. Unknown and duplicate result IDs
are invalid. Supplied `summary` and `pass` fields cannot turn incomplete results into a pass.

The legacy scripted adapter retains selected-suite exit semantics for Argos's conformance subset:
exit 0 means matched tests passed, not that the entire contract was exercised. Its output separates
`suitePass` from whole-contract `pass` and `complete`. Validate its output with `verify --report`
when whole-contract coverage is required. Empty suites never pass. Formal checks in Argos already
run directly through its own pinned Quint/TLC tooling; this change does not replace those checks.

`prove` renders a report; its exit code is not a verification gate. Evidence badges describe
matching recorded artifacts, not trusted authorship or independent execution. A method label or a
free-text step number alone no longer earns a recorded-evidence badge.

## Removed scope

- Bundled QA/capture agent, Claude SDK integration, interactive chat, test generation, auto-routing,
  cross-checking, fault injection, and credential/session management.
- Learning/memory/confidence stores, formula compilation, temporal monitors, navigation models,
  inferred Quint drafts, formal checker/trace orchestration, and learned-state ID migration.
- Daemon/inbox/workers, Kubernetes integration, Terraform/deployment helpers, Docker image
  publishing, HTTP MCP/session/event APIs, and live review webapp/server.
- CLI commands `capture`, `create`, `human`, `review`, `daemon`, `deploy`, `spec compile`, and
  `spec migrate-id`; verify modes `agent`, `auto`, and `formal`.

Use your coding agent to author requirements/tests, your test runner to execute them, and `prove`
for an offline evidence view. Use project-owned formal tools for formal contracts. Removed commands
fail with a migration error instead of silently changing meaning.

## Existing data and deployments

No migration deletes user `.specify/` directories, SQLite stores, sidecar formulas/models,
credentials, contracts, or old result bundles. Lint no longer reads or evaluates
learning/formula/Quint sidecars. Keep old data if useful for historical inspection. Renaming
behavior IDs requires coordinating external result producers; historical IDs and report data are not
rewritten automatically.

Deployment source and automatic image publishing are removed from this repository. Existing pinned
0.2 images and independently managed infrastructure remain untouched. Do not replace a daemon
container with the 0.3 CLI: migrate its callers first or retain its pinned image. The previously
recorded Renzo deployment was not available for live inspection during this change; no claim of
operational migration is made.

Rollback code through Git or use the prior 0.2.24 revision (`9069c23`). Because this change does not
rewrite external data, rollback does not require a data conversion. New strict result validation can
reject old malformed or unknown-ID bundles; correct those records or inspect them with the old
reader.
