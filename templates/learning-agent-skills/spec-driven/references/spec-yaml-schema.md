# specify.spec.yaml Schema Reference

Canonical schema the `spec-driven` skill expects. Version 2.

## Top level

```yaml
version: "2"           # required
name: string           # required, human label
description: string    # required, multiline ok
target:                # required
  type: cli | web | http
  binary: ./path       # cli only
  base_url: https://   # web | http
areas:                 # required, non-empty
  - <area>
```

## Area

```yaml
- id: kebab-case-id    # required, unique within spec
  name: string         # required
  prose: string        # optional, area-level context
  behaviors:           # required, non-empty
    - <behavior>
```

## Behavior

```yaml
- id: kebab-case-id    # required, unique within area
  description: string  # required, single observable claim
  scope: string        # optional, narrows applicability
  evidence: string     # optional, hint about what evidence to capture
  destructive: bool    # optional, default false; runs last in phase 2
```

## Conventions

- IDs are kebab-case, ASCII, stable across spec edits. Renames break audit history.
- `description` is **one** claim. Multi-claim descriptions get split into multiple behaviors during plan time.
- Avoid pre-baking the verification command in `description`. Describe the *outcome*, not the steps.
