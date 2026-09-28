# Specify

Capture the intent behind changes, retrieve relevant decisions while coding, and check that reviews
account for those decisions alongside behavioral contracts and external test evidence.

Specify keeps intent records and behavioral contracts explicit. Your coding agent still writes code
and tests, and your test runner executes them. Specify does not provide an LLM, browser agent,
daemon, formal checker, or deployment platform.

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
npm run build
./specify intent init
```

`intent init` creates `specify.intent/records/` and appends managed agent instructions to the root
`AGENTS.md`, preserving existing text. Capture a durable decision, then retrieve it while working:

```json
{
  "id": "keep-export-format-stable",
  "statement": "Existing exports remain readable by the current importer.",
  "kind": "decision",
  "source": { "text": "Keep existing customer exports importable during the redesign." },
  "appliesTo": ["src/export/", "src/import/legacy.ts"]
}
```

```bash
./specify intent capture --input intent-record.json
./specify intent context --paths src/export/writer.ts
```

Capture once: records are create-only by ID. Keep records in Git with the code they guide. After
editing, stage the complete change, reconcile every changed file against the pull request base SHA,
and run the check. Commit `specify.intent/review.json` with the reviewed change so the same review
survives clone and CI. Initialization does not install hooks; add `intent check` to your CI or hook
explicitly. See the [intent workflow](docs/intent-workflow.md) for review input and gate details.

Behavioral contracts remain available for stable requirements and external test evidence. To author
or lint one, run `./specify spec guide` and `./specify spec lint --spec specify.spec`.

Write a contract:

```yaml
version: '2'
name: Shop
target:
  type: web
  url: http://localhost:3000
areas:
  - id: cart
    name: Shopping cart
    behaviors:
      - id: add-item
        description: Adding an item increases the cart count by one
```

Keep `cart/add-item` stable as wording and implementation evolve. YAML, JSON, and composed directory
specs work with the same commands. See [large specs](docs/large-specs.md).

## Check external results

Have your test tooling emit `results.json`:

```json
{
  "results": [
    {
      "id": "cart/add-item",
      "status": "passed",
      "evidence": [{ "type": "text", "label": "test output", "content": "cart count: 0 -> 1" }]
    }
  ]
}
```

```bash
./specify verify --spec shop.spec.yaml --report results.json
```

Exit 0 requires every contract behavior to have a passed result. Failed results exit 1; missing or
skipped coverage exits 2; malformed results, duplicate IDs, unknown IDs, and invalid arguments
exit 10. Counts and `pass` are derived from individual results; supplied summaries are not trusted.
Valid structure and complete reported coverage do **not** prove that tests were run, that evidence
is authentic, or that assertions correctly implement the intended behavior.

## Inspect recorded evidence

Place results in `run/verify-result.json`, then create a self-contained report:

```bash
./specify prove --spec shop.spec.yaml --input run --output proof.html
```

Open `proof.html` in a browser. Legacy result wrappers, observation files, screenshots, and optional
recorded metadata remain readable. Evidence matching links claims to local artifacts; it does not
independently attest execution. `prove` exits 0 when rendering succeeds, even if verification
failed.

## Other commands

- `spec split`: split large contracts into one file per area.
- `spec context`: project contract prose into managed `PRODUCT.md` and `DESIGN.md` documents.
- `intent init|capture|context|reconcile|check`: preserve decisions, assumptions, and proposals;
  retrieve relevant intent and check change coverage.
- `schema spec` / `schema commands`: inspect supported structures and CLI parameters.
- `mcp`: local stdio tools for contract and intent authoring, retrieval, reconciliation, review, and
  discovery.
- `verify --mode scripted`: compatibility adapter for existing caller-owned Playwright suites.

The scripted adapter uses the caller's installed `@playwright/test`; it does not install a runner or
browser. Titles use `area-id/behavior-id: description`. Its exit status describes the selected
suite, while report `pass` remains false if other contract behaviors are untested. Use
`verify --report` for a strict whole-contract gate. See [migration details](docs/migration-0.3.md).

MCP configuration:

```json
{ "mcpServers": { "specify": { "command": "/path/to/specify/specify", "args": ["mcp"] } } }
```

No model credentials required. Target URLs, hooks, variables, and other v2 runner fields remain
contract metadata for compatibility; Specify does not execute target hooks or substitute
credentials.

## Development

```bash
npm run quality
npm test
```

The executable self-contract lives in [`specify.spec/`](specify.spec/spec.yaml). Update it with any
change to supported behavior. Tests validate code and the contract's structure; a passing unit suite
is not a claim that every natural-language requirement has been independently proven.
