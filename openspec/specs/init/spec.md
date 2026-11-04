# init Specification

## Purpose

`specify init` prepares a project for OpenSpec plus formal checks with one command.

## Requirements

### Requirement: Set up OpenSpec

Init SHALL run `openspec init --tools <tools> .` (default `claude`) in the project root when
`openspec/` does not exist, using `openspec` on PATH or a pinned `@fission-ai/openspec` through npx,
and SHALL leave an existing `openspec/` untouched. `--skip-openspec` skips this step.

#### Scenario: New project

- **WHEN** `specify init` runs where no `openspec/` exists
- **THEN** OpenSpec is initialized and the output reports `openspec: initialized`

#### Scenario: OpenSpec fails

- **WHEN** `openspec init` exits non-zero
- **THEN** init exits 2 and writes no agent instructions

### Requirement: Formal folder

Init SHALL create `formal/` with a short README explaining `Formal:` lines, without overwriting an
existing README.

#### Scenario: Repeated init

- **WHEN** init runs twice
- **THEN** `formal/README.md` keeps any edits from the first run

### Requirement: Managed agent instructions

Init SHALL add or update one `formal-workflow` managed region in AGENTS.md (or `--agents PATH`),
preserve all text outside it, and remove regions written by older Specify versions (`spec-workflow`,
`intent-workflow`). The instructions SHALL cover the `Formal:` syntax, keeping a before model with
`expect=fails`, temporal properties with fairness, running `formal check`, and the model-only
evidence boundary.

#### Scenario: Idempotent

- **WHEN** init runs twice
- **THEN** AGENTS.md contains exactly one `formal-workflow` region

#### Scenario: Legacy region

- **WHEN** AGENTS.md contains a `spec-workflow` region from Specify 0.7
- **THEN** that region is removed and surrounding text is kept
