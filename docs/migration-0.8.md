# Migrating to Specify 0.8

Specify 0.8 is a formal-check companion to [OpenSpec](https://github.com/Fission-AI/OpenSpec).
OpenSpec now owns the spec format, change proposals, validation and browsing.

## Removed

| 0.7 command or feature                                                   | Use instead                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `specify.spec/` YAML/JSON contracts, `spec lint`, `spec split`, `schema` | OpenSpec specs in `openspec/specs/`, `openspec validate`        |
| `spec guide`, `spec context`                                             | OpenSpec's agent instructions (`openspec init --tools …`)       |
| `spec check --base`                                                      | `openspec validate --strict` in CI, plus `specify formal check` |
| `spec init`                                                              | `specify init`                                                  |
| `view`                                                                   | `openspec view`, or read the specs on GitHub                    |
| `mcp` stdio tools                                                        | OpenSpec slash commands and skills                              |
| `formal:` entries on behaviors                                           | `Formal:` lines under OpenSpec requirements                     |
| Spec Kit adapter (`integrations/spec-kit`)                               | Removed                                                         |

Removed commands exit with code 10 and point here.

## Moving formal links

A 0.7 behavior:

```yaml
- id: count-never-negative
  description: The counter stays nonnegative.
  formal:
    - { tool: quint, file: formal/Counter.qnt, property: nonNegative, mode: verify, maxSteps: 8 }
```

becomes an OpenSpec requirement in `openspec/specs/counter/spec.md`:

```markdown
### Requirement: Count never goes negative

The counter SHALL never hold a value below zero.

Formal: quint formal/Counter.qnt nonNegative backend=apalache max-steps=8

#### Scenario: Increment from zero

- **WHEN** the counter is zero and is incremented
- **THEN** it holds one
```

Paths are now relative to the project root rather than the spec directory. `mode: verify` used
Apalache; verification now defaults to TLC, so add `backend=apalache` to keep the old behavior.

## Report changes

- `--spec` is replaced by `--root` (the directory containing `openspec/`).
- Statuses are `holds`, `fails`, `error`, `timeout` and `unavailable` (were `passed` and `failed`).
  Each result has `expect` on its check and `ok` when the status matches it.
- Results carry `requirementId` (`<capability>/<requirement name>`) and the source file and line;
  `unlinkedBehaviorIds` is now `unlinkedRequirementIds`.
- `specify init` writes a `formal-workflow` region to AGENTS.md and removes the old `spec-workflow`
  region.

## Installing

The npm package named `specify` is unrelated to this project. Install the release tarball, pinned to
a tag:

```bash
npm install --global https://github.com/gm2211/specify/releases/download/v0.8.2/specify-0.8.2.tgz
```

In a Node project, a dev dependency also works:
`npm install --save-dev github:gm2211/specify#v0.8.2` (npm cannot build a GitHub dependency in a
global install). In CI, use the reusable workflow described in [formal checks](formal.md#ci).
