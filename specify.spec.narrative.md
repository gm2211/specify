# Specify
<!-- spec-file: specify.spec.yaml -->

## Overview
<!-- spec:overview -->

Specify is a behavioral contract tool for web applications and CLIs. It creates a formal, computable description of how a system should behave, then provides deterministic tools to verify that the implementation matches the description.

The core design decision is a separation of concerns: the tool stays fully deterministic. There are no API keys, no `--llm` flags, no probabilistic outputs. Intelligence comes from the agent layer -- an LLM using Specify through its CLI, MCP server, or structured JSON output. Specify computes facts and produces structured data. Agents interpret those facts, make decisions, and drive the workflow.

A spec should be complete enough that an agent can implement and validate an entire system from it. This is the standard: if someone hands an agent a Specify spec and nothing else, the agent should be able to build the system, verify it works, and know exactly where it falls short.

The tool is designed for three audiences simultaneously. Humans read the narrative companion and review the interactive HTML browser. Agents consume structured JSON from stdout, use meaningful exit codes for branching, and discover capabilities through schema introspection. CI/CD pipelines run the deterministic CLI directly and gate on exit codes.


## The Lifecycle
<!-- spec:meta -->

Specify organizes around five primary flows. Each flow corresponds to a stage in the lifecycle of a behavioral contract. The `--help` output presents them in this order, the interactive wizard (`specify human`) offers them as the top-level menu, and each is available as a top-level command.

### Create
<!-- spec:cli:create-in-schema -->

Creating a spec from nothing. `specify create` starts an interactive interview that captures human intent and produces two artifacts: a YAML spec file and a Markdown narrative companion.

The interview is context-aware. It detects the current project state -- existing specs, capture directories, test files, e2e framework configuration -- and adapts its questions accordingly. If a project already has Playwright tests, the wizard offers to import them. If there are capture directories with `traffic.json` files, it offers to load pages from captured data.

The interview covers identity (name, base URL, description), page discovery (manual entry or crawling), and default properties (no 5xx responses, no console errors). The result is a spec that immediately works with `specify lint` and `specify verify`.

For agents, `create` is less relevant -- agents typically start from `capture` or `evolve`. But for humans starting a greenfield project, it provides a structured way to express intent before writing any code.

```
$ specify create
$ specify create --output my-app.spec.yaml
```


### Capture
<!-- spec:cli:capture-no-url -->
<!-- spec:cli:capture-invalid-url -->
<!-- spec:cli:capture-from-code-missing -->

Deriving a behavioral contract from an existing system. Capture has two modes, selected via `--from`:

**From a live URL** (`--from live`, the default): Specify launches a browser, navigates to the target URL, and records everything -- network traffic, console output, screenshots, DOM snapshots. The captured data lands in an output directory as structured JSON. By default, Specify then generates a spec from the captured data automatically. Use `--no-generate` to capture data without generating a spec.

```
$ specify capture --url http://localhost:3000 --output ./captures/my-app
$ specify capture --url https://example.com --output ./cap --no-generate
```

**From existing test code** (`--from code`): Specify analyzes existing Playwright or Cypress test files and imports them as spec items. It auto-detects the framework from configuration files or accepts an explicit `--framework` flag. This is useful when a project already has e2e tests and wants to layer Specify's contract model on top of them.

```
$ specify capture --from code --input ./tests --output spec.yaml
```

Capture validates its inputs early. An empty `--url` returns a structured `missing_parameter` error. An invalid URL returns an `invalid_url` error. These are not silent failures -- they produce JSON with error type, parameter name, and hint text, so agents can recover programmatically.


### Evolve
<!-- spec:cli:evolve-interactive -->
<!-- spec:cli:evolve-finds-gaps -->
<!-- spec:cli:evolve-no-pr-flag-ok -->
<!-- spec:cli:evolve-self-spec-finds-cli-gaps -->
<!-- spec:cli:evolve-top-level -->

Changing a contract as the product changes. Evolve is the thinking step -- it guides reasoning about what the contract should say, without making deterministic assertions about correctness.

Evolve operates in three modes:

**Interactive** (default, no flags): Analyzes the current spec for structural gaps and produces prioritized suggestions. Each suggestion has a category (`new_coverage`, `add_scenario`, `add_assertion`, `spec_hygiene`, etc.), a priority level, a rationale explaining why the change matters, a proposed spec fragment, and a question for the agent to ask the user.

```
$ specify evolve --spec spec.yaml
$ specify spec evolve --spec spec.yaml --json
```

For example, running evolve against the login page example spec finds that the `failed-login` scenario has interactions but no assertions verifying the outcome. That is a real gap -- the scenario clicks the submit button but never checks what happens. Evolve surfaces this as a suggestion with a concrete proposed change.

Running evolve against the self-spec (`specify.spec.yaml`) produces a summary showing the full command count and suggestions for improving coverage.

**PR-based** (`--pr`): Analyzes a pull request diff to identify which parts of the spec are affected by the code changes. This mode accepts a PR number or URL and optionally a `--repo` flag for disambiguation.

```
$ specify evolve --spec spec.yaml --pr 42
$ specify evolve --spec spec.yaml --pr https://github.com/org/repo/pull/42
```

**Report-based** (`--report`): Analyzes a gap report from a previous validation run and suggests spec refinements based on failures and coverage gaps.

```
$ specify evolve --spec spec.yaml --report gap-report.json
$ specify evolve --spec spec.yaml --report gap-report.json --output refined.yaml
```

The `--apply` flag enters an interactive mode where the agent walks through suggestions one by one, optionally applying them to produce a refined spec. Combined with `--url`, it can crawl a live system for additional context.

An important design boundary: `evolve` guides reasoning. It does not compute facts about the spec's structural validity (that is `lint`'s job). Do not confuse them. Lint tells you "this ID is duplicated" or "this flow references a nonexistent page." Evolve tells you "this scenario has no assertions -- consider adding one." Both are valuable, but they serve different purposes and should not be merged.


### Review
<!-- spec:cli:review-generates-html -->
<!-- spec:cli:review-no-spec -->
<!-- spec:cli:review-missing-spec-file -->

Inspecting the contract. `specify review` generates a self-contained HTML file and opens it in the default browser. The HTML embeds all data (spec, narrative, validation reports) and uses vanilla JavaScript for interactivity -- no external dependencies at runtime.

The review interface has three panels:

- **Sidebar**: A table of contents with status indicators. Each item shows a colored dot -- green for passed, red for failed, yellow for mixed results, gray for untested, orange for stale references.

- **Main content**: Toggles between two views. The **Narrative view** shows prose sections from the narrative companion, each linked to spec items via `<!~~ spec:page:login ~~>` annotations (using HTML comment syntax). The **Spec view** shows the raw spec as formatted JSON.

- **Detail panel**: Clicking any section reveals its linked validation results -- CLI command outcomes, visual assertion results, request matching status, scenario step results. Each assertion shows its type, description, and pass/fail status.

The review tool resolves `narrative_path` relative to the spec file's directory, not the current working directory. This matters for nested project structures where the spec and narrative live in subdirectories.

```
$ specify review --spec spec.yaml
$ specify review --spec spec.yaml --report gap-report.json
$ specify review --spec spec.yaml --no-open
```

When a narrative companion exists (pointed to by `narrative_path` in the spec), the review HTML includes prose alongside the structural data. When no narrative exists, the review builds sections from the spec structure itself -- pages become sections, scenarios become subsections.

If a narrative references a spec item that no longer exists (e.g., `<!~~ spec:page:old-login ~~>` after the page was renamed), the review marks it with an orange indicator and a "(stale)" label. This is the narrative sync validation -- it tells you when the prose has drifted from the contract.


### Verify
<!-- spec:cli:verify-auto-detects-cli -->
<!-- spec:cli:verify-requirements-fail-not-untested -->
<!-- spec:cli:verify-cli-top-level -->
<!-- spec:cli:verify-capture-top-level -->
<!-- spec:cli:verify-url-no-browser -->

Checking that an implementation matches the contract. Verify is the assertion engine -- it produces pass/fail results with evidence.

Verify auto-detects its mode from the spec content and the flags provided:

**CLI verification** (`verify cli` or auto-detected when spec has a `cli` section): Runs each command defined in the spec's `cli.commands` array, checks exit codes, and evaluates stdout/stderr assertions. This is fully deterministic -- the tool executes the binary, captures output, and compares against the spec.

```
$ specify verify cli --spec spec.yaml
$ specify verify --spec spec.yaml   # auto-detects cli section
```

**Agent verification** (`verify --url`): Launches a browser against a live URL and runs autonomous agent-driven verification. The agent navigates pages, executes scenarios, checks visual assertions, and validates network requests.

```
$ specify verify --spec spec.yaml --url http://localhost:3000
```

**Data validation** (`verify --capture`): Validates a spec against previously captured data (offline, no browser needed). Useful for CI/CD where browser access may not be available.

```
$ specify verify --spec spec.yaml --capture ./captures/latest
```

The routing logic is explicit: `--url` without `--capture` routes to agent verification. `--capture` routes to data validation. Neither flag routes to auto-detection from the spec. If the spec has a `cli` section, it runs CLI verification. If it has pages but no target, it tells you to provide one.

Exit codes encode the result: `0` for all passed, `1` for assertion failures, `2` for all untested, `10` for parse errors, `14` for browser errors. These are designed for agent branching -- an agent can check the exit code and decide its next action without parsing output.


## The Spec Format
<!-- spec:cli:lint-valid-spec -->
<!-- spec:cli:lint-self-spec -->
<!-- spec:cli:schema-spec -->

A Specify spec is a YAML (or JSON) document that describes behavioral expectations. The format is designed to be both human-readable and machine-verifiable.

### Identity

Every spec starts with identity fields:

```yaml
version: "1.0"
name: "Login Page Spec"
description: "Simple login page with form submission and redirect"
```

`version` is the spec format version. `name` is human-readable, used in review output and reports. `description` explains what the spec covers.


### Pages
<!-- spec:cli:validate-with-empty-capture -->

Pages describe individual views in the application. Each page has an `id` (used for cross-referencing), a `path` (URL path or pattern), and optional assertions:

```yaml
pages:
  - id: login
    path: /login
    title: "Login"

    visual_assertions:
      - type: element_exists
        selector: "form"
        description: "Login form is present"
      - type: text_contains
        selector: "button[type=submit]"
        text: "Log In"

    console_expectations:
      - level: error
        count: 0

    expected_requests:
      - method: POST
        url_pattern: "/api/auth/login"
        response:
          status: 200

    scenarios:
      - id: successful-login
        steps:
          - action: fill
            selector: "#email"
            value: "{{test_user.email}}"
          - action: click
            selector: "button[type=submit]"
          - action: wait_for_navigation
            url_pattern: "/dashboard"
```

Visual assertions check what a user sees: `element_exists`, `text_contains`, `text_matches`, `screenshot_region`, `element_count`. Each can carry a `quantifier` (`always` or `sometimes`) and a `confidence` level (`observed`, `inferred`, `reviewed`).

Expected requests check network behavior: what HTTP calls should happen when a page loads or an action is performed. Requests can assert on method, URL pattern (exact, glob, or regex), request body shape, and response properties.

Console expectations check browser console output: no errors, specific warning patterns, expected log messages.

Scenarios describe interactive workflows within a single page. Steps include `click`, `fill`, `select`, `hover`, `keypress`, `scroll`, `wait`, `wait_for_request`, `wait_for_navigation`, `assert_visible`, `assert_text`, and `assert_not_visible`.


### Flows
<!-- spec:cli:export-multi-page-flow -->

Flows describe multi-page user journeys -- sequences of navigation and interaction that span multiple pages:

```yaml
flows:
  - id: login-to-dashboard
    description: "User logs in and sees the dashboard"
    steps:
      - navigate: "/login"
      - assert_page: login
      - action: fill
        selector: "#email"
        value: "{{test_user.email}}"
      - action: click
        selector: "button[type=submit]"
      - navigate: "/dashboard"
      - assert_page: dashboard
```

Flow steps come in three types:

- **Navigate**: Go to a URL path. Supports `{{var}}` templates for portability.
- **Assert page**: Verify the current page matches a page spec by `id`. This runs all of that page's visual assertions, console expectations, and expected request checks.
- **Action**: Perform an interaction (same step types as scenarios -- click, fill, hover, etc.).

Flow steps reference pages by their `id` via `assert_page`, creating a compositional structure where page-level assertions are reused in flow-level verification. A page defined once can be asserted in multiple flows, and changes to the page spec automatically propagate to every flow that references it.

When exported to test code via `specify spec export`, multi-page flows produce multi-step tests with `page.goto` calls for navigation and `page.locator` calls for interactions. The generated code preserves the flow structure, making it readable and debuggable.


### CLI
<!-- spec:cli:cli-run-no-cli-section -->

The `cli` section defines command-line verification. It specifies a binary to invoke and a set of commands with expected behavior:

```yaml
cli:
  binary: "./specify"
  commands:
    - id: help-flag
      args: ["--help"]
      expected_exit_code: 0
      stderr_assertions:
        - type: text_contains
          text: "Usage: specify"
```

Each command specifies `args` (the argument array), `expected_exit_code`, and assertions on `stdout` and `stderr`. Assertion types include `text_contains`, `text_matches`, `json_schema`, `json_path`, `empty`, and `line_count`.

Multi-command scenarios allow sequential commands with shared state:

```yaml
cli:
  scenarios:
    - id: schema-round-trip
      steps:
        - id: get-schema
          args: ["schema", "spec"]
          expected_exit_code: 0
        - id: get-commands
          args: ["schema", "commands"]
          expected_exit_code: 0
```


### Requirements
<!-- spec:cli:verify-requirements-fail-not-untested -->

Requirements describe behavioral properties that need agent intelligence to validate. They cannot be checked by exit codes or string matching alone:

```yaml
requirements:
  - id: full-path-coverage
    description: "Every reachable path through the CLI has well-defined behavior"
    verification: agent
    validation_plan: |
      1. Discover all command paths
      2. For each path, search the spec for a test entry
      3. Produce a coverage table
    evidence_format: "A table of { path, test_id, status } entries"
```

Each requirement has a `validation_plan` that tells an agent exactly how to verify it, and an `evidence_format` that specifies the structure of the evidence the agent should produce. This is not a suggestion -- it is a contract with the agent.


### Variables

Template variables make specs portable across environments:

```yaml
variables:
  base_url: "${TARGET_BASE_URL}"
  test_user:
    email: "test@example.com"
    password: "secret123"
```

Variables use two template syntaxes:

- `{{var}}` for spec-level variables: `{{base_url}}`, `{{test_user.email}}`. These are defined in the spec's `variables` section and expanded at verification time.
- `${ENV_VAR}` for environment variable expansion: `${TARGET_BASE_URL}`, `${API_KEY}`. These are read from the process environment.

This dual syntax allows the same spec to run against localhost in development and a staging URL in CI/CD. The spec defines the variable names, the environment provides the values. An agent running verification in CI sets environment variables; a human running locally uses different values.


### Defaults

Universal properties that apply to all pages unless overridden:

```yaml
defaults:
  no_5xx: true
  no_console_errors: true
  page_load_timeout_ms: 10000
```

These are safety nets. `no_5xx` means no HTTP response should return a 5xx status code. `no_console_errors` means no `console.error` messages should appear. They apply globally and save you from adding the same assertions to every page.


### Assumptions

Preconditions that must hold for the spec to be validly tested:

```yaml
assumptions:
  - type: url_reachable
    url: "{{base_url}}"
    description: "Target application must be running"
  - type: env_var_set
    name: "TARGET_BASE_URL"
```

Assumption types include `url_reachable` (URL responds with 2xx), `env_var_set` (environment variable is non-empty), `api_returns` (endpoint returns expected status), and `selector_exists` (CSS selector exists on a page). Failed assumptions produce exit code `13`, distinct from assertion failures (`1`), so agents know the test environment was not valid.


### Narrative Path

The `narrative_path` field points to the companion narrative document:

```yaml
narrative_path: "specify.spec.narrative.md"
```

This path is resolved relative to the spec file's directory. When present, `specify lint` validates that the narrative references match actual spec items. `specify review` loads the narrative and renders it alongside the spec structure.


## Verification Model

Specify uses two distinct verification mechanisms, and they are not interchangeable.

### Mechanical Assertions

These are deterministic checks that the tool evaluates directly:

- **Exit codes**: The command exited with the expected code.
- **json_path**: A specific JSON path in the output has a specific value (e.g., `path: "error"`, `value: "unknown_command"`).
- **json_schema**: The output is valid JSON conforming to a JSON Schema (e.g., the output is an array of objects with `name`, `description`, and `parameters` fields).
- **text_contains**: The output contains a specific substring.
- **text_matches**: The output matches a regex pattern.
- **element_exists**: A CSS selector matches at least one DOM element.
- **element_count**: The count of matching elements is within bounds.

These are checked by `verify cli` for CLI specs, and by `verify --url` or `verify --capture` for page specs. No judgment is needed. The tool compares expected against actual and reports pass or fail.

### Behavioral Requirements

These are properties that need agent intelligence to validate. The classic example from the self-spec: "Every reachable path through the CLI has well-defined behavior captured in this spec."

No deterministic check can verify this. An agent needs to:
1. Discover all command paths (via schema introspection, help parsing, fuzzing)
2. Map each path to a test entry in the spec
3. Produce evidence that the mapping is complete

Agents validate behavioral requirements and write evidence files to `.specify/evidence/<requirement-id>.json`. When `verify` runs, it reads evidence files and marks requirements as passed (evidence exists and validates) or failed (no evidence).

### No "Untested" State

This is a deliberate design decision. In the verification model, everything is either passed or failed. If a behavioral requirement has no evidence, it is a failure -- not "untested." This matters because "untested" creates a gray zone where requirements can slip through indefinitely. Making it a failure forces action: either verify the requirement or remove it from the spec.

The `summary.untested` field in reports exists for mechanical assertions that could not be evaluated (e.g., a page that was not captured). But behavioral requirements are always either verified or failed.


## Agent Integration
<!-- spec:cli:no-args-self-description -->
<!-- spec:cli:schema-commands -->
<!-- spec:cli:schema-commands-has-modes -->

Specify is built for agent consumption. Every design decision reflects this.

### Self-Description

Running `specify` with no arguments produces a JSON self-description to stdout:

```json
{
  "name": "specify",
  "version": "0.1.0",
  "commands": [...],
  "global_options": [...],
  "exit_codes": { "0": "success", "1": "assertion_failure", ... },
  "hint": "Run \"specify schema commands\" for full parameter schemas."
}
```

This is the entry point for any agent encountering Specify for the first time. The self-description includes the command list, global options, exit code meanings, and a hint pointing to deeper introspection.

Human-readable help goes to stderr via `--help`. JSON goes to stdout with no arguments. This split is intentional: agents pipe stdout, humans read stderr.

### Schema Introspection
<!-- spec:cli:schema-spec -->
<!-- spec:cli:schema-report -->

`specify schema` exposes three introspection targets:

- `specify schema commands`: Returns the full command manifest -- every command with its parameters, types, required/optional status, defaults, modes, and examples. This is the same manifest used internally for routing and help generation.

- `specify schema spec`: Returns the JSON Schema for spec documents. Agents use this to validate specs they generate or to understand what fields are available.

- `specify schema report`: Returns the JSON Schema for validation reports. Agents use this to parse and reason about verification results.

Commands with multiple modes (like `verify` and `capture`) include a `modes` array describing each mode's required parameters and activation condition. For example, `verify` has `data_validation` mode (requires `--spec` and `--capture`) and `agent_verification` mode (requires `--spec` and `--url`).


### Subcommand Help
<!-- spec:cli:subcommand-help-verify -->
<!-- spec:cli:subcommand-help-evolve -->

`specify <command> --help` shows command-specific help with parameters, modes, and examples. This is not a fallback to top-level help -- it is targeted information about the specific command.

For example, `specify verify --help` shows verify-specific parameters (`--spec`, `--capture`, `--url`, `--headed`), the two modes (`data_validation` and `agent_verification`), and concrete examples. `specify evolve --help` shows evolve-specific parameters (`--pr`, `--report`, `--apply`).

This matters for discoverability. An agent encountering `verify` for the first time can run `verify --help` and learn everything it needs to invoke the command correctly, including which parameter combinations activate which modes.


### MCP Server
<!-- spec:cli:mcp-help -->

`specify mcp` starts a Model Context Protocol server that exposes Specify's capabilities as MCP tools. Any MCP-compatible client -- Claude Desktop, Cursor, Claude Code, or custom integrations -- can discover and invoke these tools.

The server supports two transports:

- **stdio** (default): For local use. The MCP client spawns `specify mcp` as a subprocess.
- **HTTP** (`--http`): For remote access. The server binds to a port and accepts MCP requests over HTTP.

```json
{
  "mcpServers": {
    "specify": { "command": "specify", "args": ["mcp"] }
  }
}
```

```json
{
  "mcpServers": {
    "specify": { "url": "http://host:8080/mcp" }
  }
}
```


### Evidence Loop

The evidence loop is how agents close the gap between behavioral requirements and verification:

1. `verify` runs and identifies unverified behavioral requirements. It reports them as failures with a message like "1 behavioral requirement(s) need agent verification."

2. The agent reads the requirement's `validation_plan` and `evidence_format`.

3. The agent executes the validation plan -- running commands, analyzing output, checking coverage.

4. The agent writes evidence to `.specify/evidence/<requirement-id>.json` in the format specified by `evidence_format`.

5. On the next `verify` run, Specify reads the evidence file and marks the requirement as passed or failed based on the evidence content.

This loop is asymmetric by design. The tool does not know how to validate behavioral requirements -- that requires judgment. The agent does not know what to validate -- that requires the spec. Together they form a complete verification system.


### Structured Output and Exit Codes

Every command follows the same output contract:

- **stdout**: Structured data (JSON by default). This is what agents parse.
- **stderr**: Human-readable messages, progress indicators, summaries. This is what humans read.
- **Exit codes**: Encode the result type for branching.

Exit codes are granular:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Assertion failure (some tests failed) |
| 2 | All untested (no assertions could be evaluated) |
| 10 | Parse error (invalid spec, unknown command, missing parameter) |
| 11 | Network error |
| 12 | Timeout |
| 13 | Assumption failure (preconditions not met) |
| 14 | Browser error (Playwright not available) |

An agent can distinguish between "the spec failed validation" (1) and "the spec file could not be parsed" (10) and "the target URL was unreachable" (11) without ever reading the output.

Global options control output format:

- `--json`: Force JSON output (even in TTY contexts).
- `--output-format <format>`: Choose between `json`, `text`, `markdown`, `ndjson`.
- `--fields <field1,field2>`: Select specific fields from the output (context window discipline).
- `--quiet`: Suppress non-essential stderr output.


## Error Handling
<!-- spec:cli:unknown-command -->
<!-- spec:cli:missing-spec-file -->
<!-- spec:cli:missing-export-framework -->

Errors are structured, not strings. An unknown command returns:

```json
{
  "error": "unknown_command",
  "command": "foo bar",
  "hint": "Run \"specify schema commands\" for available commands"
}
```

A missing parameter returns:

```json
{
  "error": "missing_parameter",
  "parameter": "--url",
  "hint": "Provide the URL to capture"
}
```

Each error includes an `error` type (for programmatic matching), context fields (which command, which parameter), and a `hint` (for recovery). The exit code is always `10` for parse/input errors.

This structure lets agents handle errors without string parsing. An agent can check `error === "missing_parameter"` and then provide the missing parameter, rather than trying to regex-match an error message.


## Spec Authoring Support
<!-- spec:cli:guide-output -->
<!-- spec:cli:export-playwright -->
<!-- spec:cli:export-cypress -->
<!-- spec:cli:export-multi-page-flow -->

### Guide

`specify spec guide` outputs a comprehensive authoring guide for agents writing specs. It includes the JSON Schema, example specs, common patterns, assertion type documentation, template variable syntax, and tips. This is designed to be consumed by an agent's context window so it can write valid specs without trial and error.

### Export

`specify spec export` converts a spec into runnable test code for Playwright or Cypress:

```
$ specify spec export --spec spec.yaml --framework playwright --json
$ specify spec export --spec spec.yaml --framework cypress --json
```

The generated code imports from the appropriate test framework, creates page objects from page specs, and translates scenarios and flows into test steps. Multi-page flows produce multi-step tests with `page.goto` and `page.locator` calls.

Export is useful for teams transitioning to Specify from an existing test framework, or for generating a baseline test suite from a spec.

### Import and Sync
<!-- spec:cli:import-nonexistent-dir -->
<!-- spec:cli:sync-no-test-files -->

`specify spec import` converts existing Playwright or Cypress tests into spec items. It analyzes test file structure, extracts page visits, selectors, assertions, and flows, and produces a spec.

`specify spec sync` performs bidirectional comparison between a spec and existing tests. It identifies spec items not covered by tests, tests not reflected in the spec, and drift between the two. This is useful for maintaining alignment as the spec and tests evolve independently.


## Lint
<!-- spec:cli:lint-valid-spec -->
<!-- spec:cli:lint-self-spec -->
<!-- spec:cli:lint-missing-spec -->

`specify lint` (or `specify spec lint`) validates spec structure without captures or a running system. It performs three levels of validation:

1. **Parse**: Can the file be read as YAML or JSON?
2. **Schema**: Does the structure conform to the spec JSON Schema?
3. **Semantic**: Are IDs unique? Do flow `assert_page` references point to real pages? Are there empty step arrays? Are template variables defined but unused? Are there pages with no assertions at all?

Lint also validates the narrative companion when `narrative_path` is set. It checks that the narrative file exists, parses correctly, and that its `<!~~ spec:page:xxx ~~>` references match actual spec items.

The result is a structured `{ valid: boolean, errors: [...] }` object. Each error includes a JSON-pointer path, severity (`error` or `warning`), message, and rule identifier.

Lint computes facts. It does not suggest improvements (that is evolve's job) or verify behavior (that is verify's job). This boundary is deliberate. A tool that mixes structural validation with improvement suggestions creates confusion about what needs fixing versus what might be nice to add.


## Interactive Mode
<!-- spec:cli:human-non-tty-exit -->
<!-- spec:cli:human-shows-lifecycle -->
<!-- spec:cli:human-create-path -->
<!-- spec:cli:human-capture-live-path -->
<!-- spec:cli:human-capture-code-path -->
<!-- spec:cli:human-capture-generate-path -->
<!-- spec:cli:human-evolve-interactive-path -->
<!-- spec:cli:human-evolve-pr-path -->
<!-- spec:cli:human-evolve-report-path -->
<!-- spec:cli:human-review-path -->
<!-- spec:cli:human-verify-data-path -->
<!-- spec:cli:human-verify-agent-path -->
<!-- spec:cli:human-verify-cli-path -->
<!-- spec:cli:human-verify-diff-path -->
<!-- spec:cli:human-verify-stats-path -->

`specify human` enters an interactive mode designed for humans who want guidance through the lifecycle. The wizard detects project state and presents the five lifecycle flows as an arrow-key menu.

Every path through the wizard is directly addressable via command-line arguments:

```
$ specify human create
$ specify human capture live
$ specify human capture code
$ specify human evolve interactive
$ specify human evolve pr
$ specify human evolve report
$ specify human review
$ specify human verify data
$ specify human verify agent
$ specify human verify cli
$ specify human verify diff
$ specify human verify stats
```

This direct-path access matters for two reasons. First, it lets users skip the menu when they know what they want. Second, it makes every sub-path testable -- the self-spec exercises each path with expected output.

Two additional interactive modes complement the wizard:

- `specify human shell`: A REPL for iterative spec development with tab completion. Useful for exploring and modifying specs interactively.

- `specify human watch`: A live TUI dashboard for monitoring agent runs and spec status. Requires a TTY and reports an error when run without one.

All interactive modes exit gracefully when no TTY is available. This is important for CI/CD environments and automated testing where stdin is not connected to a terminal.


## Development Workflow
<!-- spec:cli:bootstrap-dry-run -->
<!-- spec:cli:bootstrap-writes-files -->
<!-- spec:cli:bootstrap-idempotent -->

`specify bootstrap` sets up a specify-driven development workflow. It writes two files:

1. **CLAUDE.md section**: Instructions for AI agents describing the red-green TDD workflow with Specify. The section is wrapped in marker comments (`<!-- specify-bootstrap -->`) for idempotent updates.

2. **Git pre-commit hook**: A shell script that runs `specify lint` and `specify verify cli` before allowing commits. It finds the specify binary (checking `./specify` first, then `PATH`), runs both checks, and blocks the commit if either fails.

The workflow the bootstrap section teaches is:

1. **Evolve** -- reason through what the contract should say. Run `specify evolve` for structural signals. Use judgment, not just tool output.

2. **Write assertions first (RED)** -- update the spec with assertions that reflect intended behavior. They should fail against the current implementation.

3. **Implement the change (GREEN)** -- write code to make the failing assertions pass.

4. **Verify** -- run `specify lint` (structure valid?) then `specify verify cli` (assertions pass?).

5. **Commit spec + code together** -- the contract and implementation travel as one unit.

Bootstrap is idempotent. Running it twice is safe -- it skips files that already have the specify section. It reports structured results showing what was created, updated, or skipped.

```
$ specify bootstrap
$ specify bootstrap --dry-run
$ specify bootstrap --target-dir ./my-project
```

### Rules for Agents

The bootstrap instructions include explicit rules:

- Never skip the evolve step, even for "obvious" changes.
- If `verify cli` fails, fix the code -- not the spec (unless the spec is genuinely wrong).
- `lint` computes facts. `evolve` guides thinking. Do not confuse them.


## Report Analysis
<!-- spec:cli:report-diff-missing-a -->
<!-- spec:cli:report-stats-empty -->

Verification produces reports. Reports accumulate over time. Two commands support longitudinal analysis of these reports.

### Report Diff

`specify report diff` compares two gap reports to detect regressions. It takes two report paths (`--a` for baseline, `--b` for new) and produces a structured diff:

```
$ specify report diff --a baseline-report.json --b new-report.json
```

The diff identifies:
- **New failures**: assertions that passed in the baseline but fail in the new report.
- **Resolved failures**: assertions that failed in the baseline but pass in the new report.
- **Changed coverage**: overall coverage percentage change.

New failures produce exit code `1`, enabling CI/CD gating. A pipeline can run `report diff` against the last known-good report and block deploys when regressions appear.

### Report Stats

`specify report stats` computes statistical confidence from a history of reports:

```
$ specify report stats --history-dir .specify/history
```

It reads all reports from the history directory and calculates trends, flaky assertion detection, and confidence levels. An assertion that passes in 95 out of 100 runs has different reliability than one that passes in 100 out of 100 runs. Stats makes this distinction visible.

The history directory is populated by `verify` when run with `--history-dir`. Each run appends a timestamped report, building a longitudinal record of system behavior.


## Spec Auto-Discovery
<!-- spec:cli:spec-auto-discovery -->

Commands that take `--spec` auto-discover the spec file when the flag is omitted. The discovery logic searches the current working directory for files matching common spec patterns: `spec.yaml`, `spec.yml`, `spec.json`, `*.spec.yaml`, `*.spec.yml`.

When auto-discovery finds a spec, it logs the path to stderr: `Using auto-discovered spec: specify.spec.yaml`. When it finds multiple candidates, it reports them and asks for clarification.

This means most commands work without flags in a project that has a single spec file:

```
$ specify lint                     # finds spec.yaml or *.spec.yaml
$ specify evolve                   # finds and analyzes the spec
$ specify verify cli               # finds the spec and runs CLI checks
```

Explicit `--spec` always takes precedence over auto-discovery.


## Narrative Sync
<!-- spec:cli:narrative-relative-path-lint -->
<!-- spec:cli:narrative-relative-path-review -->

The narrative companion and the spec are separate files that reference each other. The `narrative_path` field in the spec points to the narrative. The `<!~~ spec:page:xxx ~~>` annotations in the narrative point back to spec items.

This bidirectional linking creates a sync problem: either side can change without the other. Specify handles this in three places:

1. **Lint**: When `narrative_path` is set, lint checks that the narrative file exists and that its spec references match actual spec items. A reference to a deleted page produces a warning.

2. **Review**: The HTML browser shows stale references with an orange indicator and "(stale)" label. A human reviewing the contract can see immediately where the narrative has drifted.

3. **Evolve**: When analyzing a spec that has a narrative, evolve can suggest narrative updates as part of its suggestions (category `update_narrative`). This guides the agent to keep the prose aligned with the contract.

Path resolution is relative to the spec file's directory, not the current working directory. A spec at `src/spec/examples/nested/app.spec.yaml` with `narrative_path: "../narrative.md"` resolves to `src/spec/examples/narrative.md`.


## Design Boundaries

Several boundaries in Specify's design are deliberate and should be preserved.

**Lint computes facts. Evolve guides reasoning.** Lint tells you "this flow references page `foo` which does not exist." Evolve tells you "this login page has no error-state scenario -- consider adding one." Both are valuable. Both should stay separate. Mixing them creates a tool that gives structural errors and improvement suggestions in the same output, making it unclear what must be fixed versus what could be improved.

**The tool stays deterministic.** No API keys. No LLM calls. No probabilistic outputs. Every time you run the same command with the same inputs, you get the same result. This makes Specify safe for CI/CD, reproducible for debugging, and trustworthy for verification. Intelligence comes from the agent layer -- the LLM that reads the structured output and makes decisions.

**A spec is not a test suite.** A test suite is a collection of executable checks. A spec is a behavioral contract that serves both humans and agents. The narrative makes it readable. The structured format makes it verifiable. The agent integration makes it actionable. Test suites can be generated from a spec (via `export`), but the spec is the source of truth, not the tests.

**Unverified requirements are failures, not "untested."** If a behavioral requirement exists in the spec and no agent has provided evidence for it, that is a failure. This prevents requirements from accumulating without verification. If you cannot verify a requirement, remove it from the spec or dispatch an agent to verify it.

**Structured output to stdout, human text to stderr.** This is not a style choice -- it is a contract with agents. Agents parse stdout. Humans read stderr. Mixing them breaks both consumers. Every command in Specify follows this contract.

**Errors are typed, not strings.** An `unknown_command` error has an `error` field set to `"unknown_command"`, a `command` field with the attempted command, and a `hint` with recovery guidance. Agents match on the `error` field. They never need to regex-match an error message.

**Exit codes are meaningful.** The difference between exit code 1 (assertion failure) and exit code 10 (parse error) and exit code 13 (assumption failure) matters. An agent seeing exit code 13 knows the test environment was not ready -- it should fix the environment, not the spec.


## Self-Specification
<!-- spec:cli:no-args-self-description -->
<!-- spec:cli:evolve-no-pr-flag-ok -->

Specify specifies itself. The `specify.spec.yaml` file in the project root is a behavioral contract for the Specify CLI. It defines 77 CLI commands with expected exit codes and output assertions, multi-command scenarios for integration testing, and behavioral requirements that need agent verification (like full path coverage).

Running `specify verify cli --spec specify.spec.yaml` executes every command in the self-spec and reports pass/fail results. This is the primary test suite for the Specify CLI -- the tool verifies itself using its own verification engine.

The self-spec covers several categories:

- **Self-description**: Running with no arguments produces valid JSON with name, version, commands, global options, and exit codes. Every registered command appears in the output.
- **Schema introspection**: All three schema targets (spec, report, commands) produce valid JSON conforming to expected schemas.
- **Error handling**: Invalid inputs produce structured error JSON with error type, context, and hints. Unknown commands, missing files, invalid URLs, and empty parameters all have dedicated test entries.
- **Feature verification**: Each command is tested with representative inputs -- exports produce framework-specific code, evolve finds real gaps, lint validates structure, review generates HTML.
- **Scenario sequences**: Multi-command scenarios test round-trips (schema for all targets) and cross-framework consistency (export to both Playwright and Cypress).
- **Interactive paths**: Every sub-path through the `human` wizard is directly addressable and tested.
- **Behavioral requirements**: Properties like "every reachable CLI path has a test entry" that need agent intelligence to verify.

Running `specify evolve --spec specify.spec.yaml` against the self-spec produces a summary showing the full command count (77) and suggestions for improving coverage. This is the feedback loop: the tool uses its own analysis capabilities to identify gaps in its own specification.

This self-referential quality is intentional. If Specify cannot specify its own behavior completely and verify it reliably, it has no business asking other projects to do the same.

The companion document you are reading now is itself the narrative for the self-spec. The `narrative_path` field in `specify.spec.yaml` points to this file, and the `<!-- spec:... -->` annotations throughout link prose sections to specific spec items. Running `specify review --spec specify.spec.yaml` renders this narrative alongside the spec structure in an interactive HTML browser, with validation results overlaid on each section.
