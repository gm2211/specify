```

   ███████╗██████╗ ███████╗ ██████╗██╗███████╗██╗   ██╗
   ██╔════╝██╔══██╗██╔════╝██╔════╝██║██╔════╝╚██╗ ██╔╝
   ███████╗██████╔╝█████╗  ██║     ██║█████╗   ╚████╔╝
   ╚════██║██╔═══╝ ██╔══╝  ██║     ██║██╔══╝    ╚██╔╝
   ███████║██║     ███████╗╚██████╗██║██║        ██║
   ╚══════╝╚═╝     ╚══════╝ ╚═════╝╚═╝╚═╝        ╚═╝

   Write specs. Validate behavior. Ship with evidence.

```

Specify turns functional requirements into machine-verifiable specs. Define what your app should do — pages, flows, assertions, API contracts — and Specify tells you what's met, what's not, and what's untested. Every assertion shows its work: expected value, actual value, raw output.

No opinions about your test framework. No lock-in. Just structured truth.

---

<p align="center">
  <img src="assets/demo.svg" alt="Specify CLI demo" width="780"/>
</p>

---

## Install

```bash
npm install
npm run build
```

## Lifecycle

```bash
# 1. Create a contract
specify create                   # interactive interview → spec + narrative

# 2. Capture existing behavior
specify capture --url http://localhost:3000 --output ./captures

# 3. Evolve the contract as the product changes
specify evolve --spec app.spec.yaml --pr 42

# 4. Review the contract
specify review --spec app.spec.yaml

# 5. Verify the implementation
specify verify --spec app.spec.yaml --capture ./captures
specify verify cli --spec app.spec.yaml
```

## Commands

| Command | What |
|---------|------|
| **`create`** | Interactive interview → spec + narrative |
| **`capture`** | Capture from live system (`--url`) or code (`--from code`) |
| **`evolve`** | Reason through contract changes (PR, report, interactive) |
| **`review`** | Inspect the contract in a browser |
| **`verify`** | Verify against captures (`--capture`) or live (`--url`) |
| `verify cli` | Run CLI commands defined in spec, validate output |
| `lint` | Structural validation (no captures needed) |
| `spec export` | Generate Playwright or Cypress tests from spec |
| `spec import` | Import existing e2e tests as spec items |
| `spec sync` | Bidirectional diff: spec vs e2e tests |
| `bootstrap` | Set up specify-driven development workflow |
| `schema` | Emit JSON Schema for spec, report, or commands |
| `mcp` | MCP server — any LLM client can use Specify as a tool |

## Reports you can trust

Every validation report includes **expected vs actual evidence** for every assertion. No "100% passed, trust me" — you get the raw output, the exact match, and the assertion logic.

Formats: **JSON** (machine), **Markdown** (diff-friendly), **HTML** (interactive, filterable, single file).

```
| Status | Type           | Expected          | Actual                              |
|--------|----------------|-------------------|-------------------------------------|
| ✅     | text_contains  | spec validate     | ..."name": "spec validate", ...     |
| ✅     | json_path      | 0.1.0             | 0.1.0                               |
| ❌     | json_schema    | matches schema    | /items: must have >= 5 items        |
```

## MCP — use Specify from any LLM

```bash
# Local (stdio)
specify mcp

# Remote (HTTP)
specify mcp --http --port 8080
```

Claude Desktop / Cursor / Claude Code config:
```json
{ "mcpServers": { "specify": { "command": "specify", "args": ["mcp"] } } }
```

9 tools exposed: `lint_spec`, `analyze_gaps`, `validate_spec`, `export_tests`, `get_authoring_guide`, `get_spec_summary`, `list_commands`, `parse_spec`, `spec_to_yaml`.

## Spec format

YAML or JSON. Human-readable, machine-verifiable.

```yaml
version: "1"
metadata:
  name: My App
  baseUrl: https://app.example.com

pages:
  - id: dashboard
    path: /dashboard
    visualAssertions:
      - type: visible
        description: Navigation sidebar
    expectedRequests:
      - method: GET
        pathPattern: /api/v1/stats
        status: 200

scenarios:
  - id: user-login
    steps:
      - action: navigate
        path: /login
      - action: fill
        target: Email field
        value: "{{email}}"
      - action: click
        target: Sign in button
      - action: assert
        expectation: Dashboard visible
```

## Self-verifying

Specify eats its own dogfood. The repo includes `specify.spec.yaml` — a spec for Specify itself — validated on every run. Current status: **178 assertions, 100% coverage, 0 failures.** [See the report →](cli-report/cli-report.md)

## License

GPL-3.0
