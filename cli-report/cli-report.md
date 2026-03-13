# CLI Validation Report: Specify CLI

> Self-spec for the Specify CLI tool. Validates that all commands produce correct output, exit codes, and structured data formats.


## Metadata

| Field | Value |
|-------|-------|
| Binary | `node dist/src/cli/index.js` |
| Timestamp | 2026-03-13T21:44:34.852Z |
| Spec version | `1.0` |

## Summary

| Status | Count |
|--------|-------|
| ✅ Passed | 101 |
| ❌ Failed | 1 |
| ⬜ Untested | 0 |
| **Total** | **102** |
| **Coverage** | **100%** |

---

## Commands

### ✅ `no-args-self-description`
> No arguments emits agent-friendly JSON self-description to stdout

**Args:** `` · **Duration:** 68ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "name": "specify",
  "version": "0.1.0",
  "description": "Spec-driven functional verification for web applications",
  "commands": [
    {
      "name": "spec validate",
      "description": "Validate a spec against captured data",
      "parameters": [
        {
          "name": "--spec",
          "type": "string",
          "required": true,
          "description": "Path to spec file (or - for stdin)"
        },
        {
          "name": "--capture",
          "type": "string",
     
... (12063 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `specify` | `specify` |
| ✅ | `json_path` | — | `0.1.0` | `0.1.0` |
| ✅ | `json_schema` | Self-description has required fields | `matches schema` | `valid` |
| ✅ | `json_schema` | Commands array includes all registered commands | `matches schema` | `valid` |
| ✅ | `text_contains` | Includes spec validate | `spec validate` | `...for web applications",   "commands": [     {       "name": "spec validate",  ...` |
| ✅ | `text_contains` | Includes spec generate | `spec generate` | `...port history"         }       ]     },     {       "name": "spec generate",  ...` |
| ✅ | `text_contains` | Includes spec refine | `spec refine` | `...t generation"         }       ]     },     {       "name": "spec refine",    ...` |
| ✅ | `text_contains` | Includes spec evolve | `spec evolve` | `...er page/flow"         }       ]     },     {       "name": "spec evolve",    ...` |
| ✅ | `text_contains` | Includes spec import | `spec import` | `... or commands"         }       ]     },     {       "name": "spec import",    ...` |
| ✅ | `text_contains` | Includes spec export | `spec export` | `...ed spec file"         }       ]     },     {       "name": "spec export",    ...` |
| ✅ | `text_contains` | Includes spec sync | `spec sync` | `...volve --spec spec.yaml"       ]     },     {       "name": "spec sync",      ...` |
| ✅ | `text_contains` | Includes spec lint | `spec lint` | `... if omitted)"         }       ]     },     {       "name": "spec lint",      ...` |
| ✅ | `text_contains` | Includes spec guide | `spec guide` | `...- for stdin)"         }       ]     },     {       "name": "spec guide",     ...` |
| ✅ | `text_contains` | Includes agent run | `agent run` | `...ut file path"         }       ]     },     {       "name": "agent run",      ...` |
| ✅ | `text_contains` | Includes cli run | `cli run` | `... screenshots"         }       ]     },     {       "name": "cli run",       "...` |
| ✅ | `text_contains` | Includes report diff | `report diff` | `...report files"         }       ]     },     {       "name": "report diff",    ...` |
| ✅ | `text_contains` | Includes report stats | `report stats` | `...econd report"         }       ]     },     {       "name": "report stats",   ...` |
| ✅ | `text_contains` | Includes schema | `"name": "schema"` | `... to history directory"         }       ]     },     {       "name": "schema",...` |
| ✅ | `text_contains` | Includes mcp | `"name": "mcp"` | `...LM spec writers",       "parameters": []     },     {       "name": "mcp",   ...` |
| ✅ | `text_contains` | Includes human | `"name": "human"` | `...\": \"http://host:8080/mcp\"}}}"       ]     },     {       "name": "human", ...` |
| ✅ | `text_contains` | Includes human shell | `human shell` | `...    "examples": [         "specify human",         "specify human shell --spe...` |
| ✅ | `text_contains` | Includes human watch | `human watch` | `...   "specify human shell --spec spec.yaml",         "specify human watch --spe...` |

### ❌ `help-flag`
> The --help flag prints human-readable usage to stderr

**Args:** `--help` · **Duration:** 66ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stderr preview</summary>

```
[1;36mSpecify[0m [2m—[0m spec-driven functional verification

[1mUsage:[0m specify [36m<noun>[0m [36m<verb>[0m [2m[options][0m

[1mCommands:[0m
  [36mspec validate[0m    Validate a spec against captured data
  [36mspec generate[0m    Generate a spec from capture data
  [36mspec refine[0m      Refine a spec interactively or using a gap report
  [36mspec evolve[0m      Evolve a spec from PR changes or interactively
  [36mspec import[0m      Import existing e2e tests as spec
... (1458 more chars)
```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ❌ | `text_contains` | — | `Usage: specify` | `[1;36mSpecify[0m [2m—[0m spec-driven functional verification  [1mUsage:[0m...` |
| ✅ | `text_contains` | — | `spec validate` | `...[36m<verb>[0m [2m[options][0m  [1mCommands:[0m   [36mspec validate[0m...` |
| ✅ | `text_contains` | — | `agent run` | `...0m       Output authoring guide for LLM spec writers   [36magent run[0m    ...` |
| ✅ | `text_contains` | — | `cli run` | `...[0m        Run autonomous agent-driven verification   [36mcli run[0m      ...` |
| ✅ | `text_contains` | — | `spec evolve` | `...   Refine a spec interactively or using a gap report   [36mspec evolve[0m  ...` |
| ✅ | `text_contains` | — | `human` | `...           Start MCP server for LLM tool integration   [36mhuman[0m        ...` |

### ✅ `schema-commands`
> Schema commands returns array of command definitions

**Args:** `schema commands` · **Duration:** 66ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "name": "spec validate",
    "description": "Validate a spec against captured data",
    "parameters": [
      {
        "name": "--spec",
        "type": "string",
        "required": true,
        "description": "Path to spec file (or - for stdin)"
      },
      {
        "name": "--capture",
        "type": "string",
        "required": true,
        "description": "Path to capture directory"
      },
      {
        "name": "--output",
        "type": "string",
        "required":
... (10262 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | Array of command objects | `matches schema` | `valid` |

### ✅ `schema-spec`
> Schema spec returns a JSON Schema document

**Args:** `schema spec` · **Duration:** 66ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Specify Spec",
  "description": "Computational spec format for functional verification of web applications.",
  "type": "object",
  "required": [
    "version",
    "name"
  ],
  "additionalProperties": false,
  "properties": {
    "version": {
      "type": "string",
      "description": "Spec format version."
    },
    "name": {
      "type": "string",
      "description": "Human-readable name for this spec."
    },
    "de
... (16613 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `object` | `object` |
| ✅ | `json_schema` | Valid JSON Schema document | `matches schema` | `valid` |

### ✅ `schema-report`
> Schema report returns a JSON Schema document

**Args:** `schema report` · **Duration:** 68ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Specify Gap Report",
  "type": "object",
  "required": [
    "spec",
    "capture",
    "summary",
    "pages",
    "flows"
  ],
  "properties": {
    "spec": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        }
      }
    },
    "capture": {
      "type": 
... (2896 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | — | `matches schema` | `valid` |

### ✅ `unknown-command`
> Unknown command returns exit code 10 with structured error

**Args:** `foo bar` · **Duration:** 63ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stdout preview</summary>

```
{"error":"unknown_command","command":"foo bar","hint":"Run \"specify schema commands\" for available commands"}

```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `unknown_command` | `unknown_command` |
| ✅ | `json_path` | — | `foo bar` | `foo bar` |
| ✅ | `text_contains` | — | `hint` | `{"error":"unknown_command","command":"foo bar","hint":"Run \"specify schema comm...` |

### ✅ `missing-spec-file`
> Validation with nonexistent spec returns exit code 10

**Args:** `spec validate --spec nonexistent-file-that-does-not-exist.yaml --capture .` · **Duration:** 174ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
Failed to load spec: Spec file not found: /Users/gmecocci/projects/specify/nonexistent-file-that-does-not-exist.yaml

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `Failed to load spec` | `Failed to load spec: Spec file not found: /Users/gmecocci/projects/specify/none....` |
| ✅ | `text_contains` | — | `Spec file not found` | `Failed to load spec: Spec file not found: /Users/gmecocci/projects/specify/nonex...` |

### ✅ `missing-export-framework`
> Export without framework argument fails

**Args:** `spec export --spec src/spec/examples/login-page.yaml --framework ` · **Duration:** 182ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
Unsupported framework: . Use 'playwright' or 'cypress'.

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `Unsupported framework` | `Unsupported framework: . Use 'playwright' or 'cypress'. ` |
| ✅ | `text_contains` | — | `playwright` | `Unsupported framework: . Use 'playwright' or 'cypress'. ` |

### ✅ `export-playwright`
> Export spec as Playwright test code

**Args:** `spec export --spec src/spec/examples/login-page.yaml --framework playwright --json` · **Duration:** 175ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "filePath": "login-page-spec.spec.ts",
    "content": "import { test, expect } from '@playwright/test';\n\ntest.describe('login', () => {\n  test('login — visual assertions', async ({ page }) => {\n    await page.goto('${TARGET_BASE_URL}/login');\n    await expect(page.locator('form')).toBeVisible();\n    await expect(page.locator('#email')).toBeVisible();\n    await expect(page.locator('#password')).toBeVisible();\n    await expect(page.locator('button[type=submit]')).toBeVisible();\n
... (1010 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | Array of generated test files | `matches schema` | `valid` |
| ✅ | `text_contains` | — | `playwright` | `...ec.spec.ts",     "content": "import { test, expect } from '@playwright/test';...` |
| ✅ | `text_contains` | Generated code imports from @playwright/test | `@playwright/test` | `...pec.spec.ts",     "content": "import { test, expect } from '@playwright/test'...` |

### ✅ `export-cypress`
> Export spec as Cypress test code

**Args:** `spec export --spec src/spec/examples/login-page.yaml --framework cypress --json` · **Duration:** 172ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "filePath": "login-page-spec.cy.ts",
    "content": "describe('login', () => {\n  it('login — visual assertions', () => {\n    cy.visit('${TARGET_BASE_URL}/login');\n    cy.get('form').should('be.visible');\n    cy.get('#email').should('be.visible');\n    cy.get('#password').should('be.visible');\n    cy.get('button[type=submit]').should('be.visible');\n    cy.get('button[type=submit]').should('contain', 'Log In');\n  });\n\n  it('successful-login — User logs in with valid credentials'
... (763 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `cy.visit` | `...n', () => {\n  it('login — visual assertions', () => {\n    cy.visit('${TARGE...` |
| ✅ | `text_contains` | — | `cy.get` | `...s', () => {\n    cy.visit('${TARGET_BASE_URL}/login');\n    cy.get('form').sh...` |

### ✅ `export-multi-page-flow`
> Export multi-page flow produces multi-step test

**Args:** `spec export --spec src/spec/examples/multi-page-flow.yaml --framework playwright --json` · **Duration:** 174ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "filePath": "e-commerce-checkout-flow.spec.ts",
    "content": "import { test, expect } from '@playwright/test';\n\ntest.beforeAll(async () => {\n  // Create test user\n  await fetch('{{base_url}}/api/test/users', {\n    method: 'POST',\n    body: JSON.stringify({\"email\":\"test@example.com\",\"password\":\"test123\"}),\n  });\n  // Seed product catalog\n  await fetch('{{base_url}}/api/test/seed-products', {\n    method: 'POST',\n    body: JSON.stringify({\"count\":10}),\n  });\n});\n
... (3498 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | Contains navigate calls for flow steps | `page.goto` | `...list — visual assertions', async ({ page }) => {\n    await page.goto('${TARG...` |
| ✅ | `text_contains` | Contains interaction code | `page.locator` | `...page.goto('${TARGET_BASE_URL}/products');\n    await expect(page.locator('.pr...` |

### ✅ `evolve-interactive`
> Interactive evolve produces structured suggestions

**Args:** `spec evolve --spec src/spec/examples/login-page.yaml --json` · **Duration:** 173ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "mode": "interactive",
  "spec_summary": {
    "name": "Login Page Spec",
    "page_count": 1,
    "flow_count": 0,
    "scenario_count": 2,
    "cli_command_count": 0,
    "cli_scenario_count": 0,
    "has_defaults": false,
    "has_assumptions": false,
    "has_hooks": false
  },
  "suggestions": [
    {
      "id": "int-1",
      "category": "spec_hygiene",
      "priority": "medium",
      "description": "No default properties set",
      "rationale": "Default properties like no_5xx, no_
... (2540 more chars)
```

</details>

<details>
<summary>stderr preview</summary>

```

[1;36mAnalyzing spec:[0m [1mLogin Page Spec[0m
  [2mPages:[0m 1  [2mFlows:[0m 0  [2mScenarios:[0m 2


[1m4[0m suggestion(s) for spec evolution

  [1;33mMedium priority:[0m
    [33m~[0m No default properties set
    [33m~[0m No assumptions (preconditions) defined
    [33m~[0m Scenario "successful-login" has interactions but no assertions

  [2mLow priority:[0m
    [2m·[0m Page "login" has no expected API requests


```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `interactive` | `interactive` |
| ✅ | `json_schema` | Evolve result has required structure | `matches schema` | `valid` |

### ✅ `evolve-finds-gaps`
> Interactive evolve finds real gaps in example spec

**Args:** `spec evolve --spec src/spec/examples/login-page.yaml --json` · **Duration:** 178ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "mode": "interactive",
  "spec_summary": {
    "name": "Login Page Spec",
    "page_count": 1,
    "flow_count": 0,
    "scenario_count": 2,
    "cli_command_count": 0,
    "cli_scenario_count": 0,
    "has_defaults": false,
    "has_assumptions": false,
    "has_hooks": false
  },
  "suggestions": [
    {
      "id": "int-1",
      "category": "spec_hygiene",
      "priority": "medium",
      "description": "No default properties set",
      "rationale": "Default properties like no_5xx, no_
... (2540 more chars)
```

</details>

<details>
<summary>stderr preview</summary>

```

[1;36mAnalyzing spec:[0m [1mLogin Page Spec[0m
  [2mPages:[0m 1  [2mFlows:[0m 0  [2mScenarios:[0m 2


[1m4[0m suggestion(s) for spec evolution

  [1;33mMedium priority:[0m
    [33m~[0m No default properties set
    [33m~[0m No assumptions (preconditions) defined
    [33m~[0m Scenario "successful-login" has interactions but no assertions

  [2mLow priority:[0m
    [2m·[0m Page "login" has no expected API requests


```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | Analyzes the login page spec | `1` | `1` |
| ✅ | `text_contains` | Finds the missing-assertion scenario gap | `interactions but no assertions` | `...m",       "description": "Scenario \"successful-login\" has interactions but ...` |

### ✅ `evolve-no-pr-flag-ok`
> Evolve without --pr uses interactive mode

**Args:** `spec evolve --spec specify.spec.yaml --json` · **Duration:** 177ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "mode": "interactive",
  "spec_summary": {
    "name": "Specify CLI",
    "page_count": 0,
    "flow_count": 0,
    "scenario_count": 0,
    "cli_command_count": 24,
    "cli_scenario_count": 2,
    "has_defaults": false,
    "has_assumptions": false,
    "has_hooks": false
  },
  "suggestions": [
    {
      "id": "int-1",
      "category": "spec_hygiene",
      "priority": "medium",
      "description": "No default properties set",
      "rationale": "Default properties like no_5xx, no_con
... (439 more chars)
```

</details>

<details>
<summary>stderr preview</summary>

```

[1;36mAnalyzing spec:[0m [1mSpecify CLI[0m
  [2mPages:[0m 0  [2mFlows:[0m 0  [2mScenarios:[0m 0
  [2mCLI commands:[0m 24  [2mCLI scenarios:[0m 2


[1m1[0m suggestion(s) for spec evolution

  [1;33mMedium priority:[0m
    [33m~[0m No default properties set


```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `interactive` | `interactive` |
| ✅ | `json_path` | Sees our CLI commands | `24` | `24` |

### ✅ `import-nonexistent-dir`
> Import from nonexistent path fails gracefully

**Args:** `spec import --from nonexistent-test-dir-xyz` · **Duration:** 175ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
Path not found: /Users/gmecocci/projects/specify/nonexistent-test-dir-xyz

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `Path not found` | `Path not found: /Users/gmecocci/projects/specify/nonexistent-test-dir-xyz ` |

### ✅ `cli-run-no-cli-section`
> CLI run with spec that has no cli section fails

**Args:** `cli run --spec src/spec/examples/login-page.yaml` · **Duration:** 175ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
Spec has no cli section.

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `no cli section` | `Spec has no cli section. ` |

### ✅ `validate-with-empty-capture`
> Validate spec against empty capture dir produces report

**Args:** `spec validate --spec src/spec/examples/login-page.yaml --capture src/spec/examples --json` · **Duration:** 173ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "spec": {
    "name": "Login Page Spec",
    "version": "1.0",
    "description": "Simple login page with form submission and redirect"
  },
  "capture": {
    "directory": "/Users/gmecocci/projects/specify/src/spec/examples",
    "timestamp": "2026-03-13T21:44:33.146Z",
    "targetUrl": "",
    "totalRequests": 0
  },
  "summary": {
    "total": 20,
    "passed": 1,
    "failed": 0,
    "untested": 19,
    "coverage": 5
  },
  "pages": [
    {
      "pageId": "login",
      "path": "/login"
... (3953 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | Gap report structure | `matches schema` | `valid` |
| ✅ | `json_path` | — | `Login Page Spec` | `Login Page Spec` |
| ✅ | `json_path` | Most assertions untested since no traffic | `5` | `5` |

### ✅ `sync-no-test-files`
> Spec sync fails when no test files found

**Args:** `spec sync --spec src/spec/examples/login-page.yaml --tests src/spec` · **Duration:** 177ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
No test files found in: /Users/gmecocci/projects/specify/src/spec

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `No test files found` | `No test files found in: /Users/gmecocci/projects/specify/src/spec ` |

### ✅ `evolve-self-spec-finds-cli-gaps`
> Evolve finds assertion gaps in own CLI spec

**Args:** `spec evolve --spec specify.spec.yaml --json` · **Duration:** 183ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "mode": "interactive",
  "spec_summary": {
    "name": "Specify CLI",
    "page_count": 0,
    "flow_count": 0,
    "scenario_count": 0,
    "cli_command_count": 24,
    "cli_scenario_count": 2,
    "has_defaults": false,
    "has_assumptions": false,
    "has_hooks": false
  },
  "suggestions": [
    {
      "id": "int-1",
      "category": "spec_hygiene",
      "priority": "medium",
      "description": "No default properties set",
      "rationale": "Default properties like no_5xx, no_con
... (439 more chars)
```

</details>

<details>
<summary>stderr preview</summary>

```

[1;36mAnalyzing spec:[0m [1mSpecify CLI[0m
  [2mPages:[0m 0  [2mFlows:[0m 0  [2mScenarios:[0m 0
  [2mCLI commands:[0m 24  [2mCLI scenarios:[0m 2


[1m1[0m suggestion(s) for spec evolution

  [1;33mMedium priority:[0m
    [33m~[0m No default properties set


```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `interactive` | `interactive` |
| ✅ | `json_schema` | Each suggestion has all required fields | `matches schema` | `valid` |

### ✅ `lint-valid-spec`
> Lint a valid spec returns valid=true

**Args:** `spec lint --spec src/spec/examples/login-page.yaml` · **Duration:** 175ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "valid": true,
  "errors": [
    {
      "path": "/variables",
      "severity": "warning",
      "message": "Template variable \"{{test_user}}\" is used but not defined in variables (may be set by a hook save_as)",
      "rule": "undefined-variable"
    }
  ]
}

```

</details>

<details>
<summary>stderr preview</summary>

```
[1;32m✓ Spec is valid[0m[33m (1 warning)[0m

```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `true` | `true` |

### ✅ `lint-self-spec`
> Lint the self-spec returns valid=true

**Args:** `spec lint --spec specify.spec.yaml` · **Duration:** 173ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "valid": true,
  "errors": []
}

```

</details>

<details>
<summary>stderr preview</summary>

```
[1;32m✓ Spec is valid[0m

```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_path` | — | `true` | `true` |
| ✅ | `json_schema` | — | `matches schema` | `valid` |

### ✅ `lint-missing-spec`
> Lint a nonexistent spec fails

**Args:** `spec lint --spec nonexistent.yaml` · **Duration:** 169ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
Spec file not found: /Users/gmecocci/projects/specify/nonexistent.yaml

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `Spec file not found` | `Spec file not found: /Users/gmecocci/projects/specify/nonexistent.yaml ` |

### ✅ `guide-output`
> Guide outputs schema, examples, patterns, and tips

**Args:** `spec guide` · **Duration:** 68ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Specify Spec",
    "description": "Computational spec format for functional verification of web applications.",
    "type": "object",
    "required": [
      "version",
      "name"
    ],
    "additionalProperties": false,
    "properties": {
      "version": {
        "type": "string",
        "description": "Spec format version."
      },
      "name": {
        "type": "string",
        "description": "Hu
... (38695 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | Guide has all required sections | `matches schema` | `valid` |
| ✅ | `text_contains` | Includes example specs | `Login Page Spec` | `...mplate variables",       "yaml": "version: \"1.0\"\nname: \"Login Page Spec\"...` |
| ✅ | `text_contains` | Includes assertion type docs | `element_exists` | `...     "type": "string",             "enum": [               "element_exists", ...` |

### ✅ `evolve-missing-spec`
> Evolve with nonexistent spec fails

**Args:** `spec evolve --spec nonexistent.yaml` · **Duration:** 175ms

**Exit code:** expected `10`, got `10` ✅

<details>
<summary>stderr preview</summary>

```
Failed to load spec: Spec file not found: /Users/gmecocci/projects/specify/nonexistent.yaml

```

</details>

**stderr assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `Failed to load spec` | `Failed to load spec: Spec file not found: /Users/gmecocci/projects/specify/none....` |

---

## Scenarios

### ✅ Scenario: `schema-introspection-suite`
> All schema targets produce valid JSON

### ✅ `schema-spec-step`

**Args:** `schema spec` · **Duration:** 69ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Specify Spec",
  "description": "Computational spec format for functional verification of web applications.",
  "type": "object",
  "required": [
    "version",
    "name"
  ],
  "additionalProperties": false,
  "properties": {
    "version": {
      "type": "string",
      "description": "Spec format version."
    },
    "name": {
      "type": "string",
      "description": "Human-readable name for this spec."
    },
    "de
... (16613 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | — | `matches schema` | `valid` |

### ✅ `schema-report-step`

**Args:** `schema report` · **Duration:** 72ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Specify Gap Report",
  "type": "object",
  "required": [
    "spec",
    "capture",
    "summary",
    "pages",
    "flows"
  ],
  "properties": {
    "spec": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        }
      }
    },
    "capture": {
      "type": 
... (2896 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | — | `matches schema` | `valid` |

### ✅ `schema-commands-step`

**Args:** `schema commands` · **Duration:** 71ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "name": "spec validate",
    "description": "Validate a spec against captured data",
    "parameters": [
      {
        "name": "--spec",
        "type": "string",
        "required": true,
        "description": "Path to spec file (or - for stdin)"
      },
      {
        "name": "--capture",
        "type": "string",
        "required": true,
        "description": "Path to capture directory"
      },
      {
        "name": "--output",
        "type": "string",
        "required":
... (10262 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `json_schema` | — | `matches schema` | `valid` |

### ✅ Scenario: `export-both-frameworks`
> Exporting the same spec to both frameworks succeeds

### ✅ `export-pw-step`

**Args:** `spec export --spec src/spec/examples/login-page.yaml --framework playwright --json` · **Duration:** 179ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "filePath": "login-page-spec.spec.ts",
    "content": "import { test, expect } from '@playwright/test';\n\ntest.describe('login', () => {\n  test('login — visual assertions', async ({ page }) => {\n    await page.goto('${TARGET_BASE_URL}/login');\n    await expect(page.locator('form')).toBeVisible();\n    await expect(page.locator('#email')).toBeVisible();\n    await expect(page.locator('#password')).toBeVisible();\n    await expect(page.locator('button[type=submit]')).toBeVisible();\n
... (1010 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `@playwright/test` | `...pec.spec.ts",     "content": "import { test, expect } from '@playwright/test'...` |

### ✅ `export-cy-step`

**Args:** `spec export --spec src/spec/examples/login-page.yaml --framework cypress --json` · **Duration:** 176ms

**Exit code:** expected `0`, got `0` ✅

<details>
<summary>stdout preview</summary>

```
[
  {
    "filePath": "login-page-spec.cy.ts",
    "content": "describe('login', () => {\n  it('login — visual assertions', () => {\n    cy.visit('${TARGET_BASE_URL}/login');\n    cy.get('form').should('be.visible');\n    cy.get('#email').should('be.visible');\n    cy.get('#password').should('be.visible');\n    cy.get('button[type=submit]').should('be.visible');\n    cy.get('button[type=submit]').should('contain', 'Log In');\n  });\n\n  it('successful-login — User logs in with valid credentials'
... (763 more chars)
```

</details>

**stdout assertions:**

| Status | Type | Description | Expected | Actual |
|--------|------|-------------|----------|--------|
| ✅ | `text_contains` | — | `cy.visit` | `...n', () => {\n  it('login — visual assertions', () => {\n    cy.visit('${TARGE...` |

---

_Generated by Specify CLI validator · 2026-03-13T21:44:34.854Z_
