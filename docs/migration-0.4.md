# Migrating to 0.4

Version 0.4 makes the selected behavioral spec the source of product direction. Behaviors may carry
`source.text` with exact user wording and optional `source.reference`. `spec init` installs managed
agent guidance; `spec check` lints the selected spec and requires a spec change or an explicit
reason when repository files change without one.

Retained commands: `spec lint`, `spec split`, `spec context`, `spec guide`, schema introspection,
and five local stdio MCP authoring tools. New commands: `spec init [--spec PATH] [--agents PATH]`
and `spec check [--spec PATH] --base REF [--reason TEXT]`; omitted spec paths use normal discovery.

Removed from 0.4: the separate intent ledger and its commands, MCP tools, and completion review;
`verify`, `prove`, external-result reporting, and the caller-owned Playwright adapter. Three Specify
product-direction records moved into the self-spec with their local IDs, source wording, and
rationale. The approved pruning correction is recorded there and supersedes promises for a separate
ledger or completion-evidence layer.

The CLI does not automatically delete or rewrite external intent packs, reports, result bundles,
`.specify/` data, or caller files. There is no generic automated migration. Callers that still
depend on 0.3 result or adapter behavior should pin 0.3 or migrate individually.

Rollback through Git to `ab58690` (the 0.3 implementation). The 0.4 executable does not rewrite
external user data.
