# Specify

Behavioral contracts with stable IDs, structural linting, and external test evidence.

Specify keeps intended behavior explicit and checks whether recorded results cover that contract.
Your coding agent writes code and tests. Your test runner executes them. Specify does not provide an
LLM, browser agent, daemon, formal checker, or deployment platform.

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
npm run build
./specify spec guide
./specify spec lint --spec specify.spec
```

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
- `schema spec` / `schema commands`: inspect supported structures and CLI parameters.
- `mcp`: local stdio tools for contract authoring, parsing, linting, and command discovery.
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
