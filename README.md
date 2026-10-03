# Specify

Keep product intent in one small, versioned behavioral spec. Stable behavior IDs make decisions
reviewable as code changes; source quotes keep user direction attached to the behavior it governs.

```bash
npm ci
npm run build
./specify spec init --spec specify.spec
./specify spec check --spec specify.spec --base "$BASE"
```

`spec init` adds concise managed instructions to `AGENTS.md`. `spec check` lints the selected spec
and requires a spec change or an explicit reason when repository files change without one. See
[workflow](docs/workflow.md) and [0.4 migration notes](docs/migration-0.4.md).

Use `spec guide` to author a v2 YAML or JSON contract. `spec lint`, `spec split`, `spec context`,
`formal check`, `schema`, and local stdio MCP tools support authoring and bounded checks of
explicitly linked formal models. Formal checks report properties of those models, not semantic
agreement with the prose or correctness of the application. See [formal checks](docs/formal.md) for
tool setup, examples, and limits. Specify does not run application tests or manage a separate intent
ledger.
