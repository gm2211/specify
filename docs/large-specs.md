# Large specs

For larger products, `--spec` may point at a directory instead of one YAML file. Specify composes
the directory into one logical behavioral contract before linting, results validation, context
projection, and evidence rendering:

```text
spec/
  spec.yaml
  areas/
    auth.yaml
    billing.yaml
```

`spec/spec.yaml` holds top-level metadata and may declare area order:

```yaml
version: '2'
name: 'My App'
target:
  type: web
  url: 'http://localhost:3000'
areas:
  - areas/auth.yaml
  - areas/billing.yaml
```

Each area file contains one normal area object:

```yaml
id: auth
name: Authentication
behaviors:
  - id: login-valid-credentials
    description: A user with valid credentials can log in and sees the dashboard
```

When `areas` is omitted from the manifest, `areas/**/*.yaml`, `areas/**/*.yml`, and
`areas/**/*.json` are composed in sorted path order. Existing commands keep the same one-value form:

```bash
specify spec lint --spec spec/
specify verify --spec spec/ --report results.json
specify prove --spec spec/ --input run/
```

`specify spec lint` warns when a single YAML/JSON spec starts getting unwieldy (more than about 40
KiB, 800 lines, 12 areas, or 120 behaviors). Split it mechanically with:

```bash
specify spec split --spec spec.yaml --output spec/
```

The split command writes `spec/spec.yaml` plus one file per area under `spec/areas/`. Directory
specs do not trigger single-file size limits. Files above 80 KiB, 1600 lines, 24 areas, or 240
behaviors fail lint; split them before continuing.

`specify spec context` regenerates `PRODUCT.md` and `DESIGN.md` straight from the composed spec — a
deterministic projection, no LLM call, so the spec's own area prose and behavior descriptions ARE
the content:

```bash
specify spec context
specify spec context --spec spec/ --out-dir docs --json
```

Every claim carries an inline `[area/behavior]` traceability anchor back to its source, e.g.
`[auth/valid-login]`. `DESIGN.md` keeps two sources separate and clearly labeled: spec-derived
"Product Constraints" (behaviors tagged `design`, `ui`, `ux`, `visual`, `accessibility`, `a11y`,
`style`, `layout`, `branding`, or `theme`) and an optional "Visual Tokens" pass that extracts real
values from code (`tokens.json`/`design-tokens.json`, CSS custom properties) — never invented ones.
An area with no prose, a spec with no design-tagged behaviors, or a codebase with no token sources
yields an omitted or explicitly-empty section, not fabricated text.

Regeneration is non-destructive: generated content lives inside
`<!-- specify:begin:product-context -->` / `<!-- specify:end:... -->` marker pairs, and only that
region is replaced on each run — anything you write outside the markers survives every regeneration.
If a target file already exists but has no markers (hand-authored before this feature, or edited
such that they were removed), Specify refuses to touch it and writes a reviewable
`PRODUCT.proposed.md` / `DESIGN.proposed.md` alongside it instead; pass `--force` to overwrite in
place anyway.
