# init Specification

## Purpose

`specify init` prepares a project for OpenSpec plus formal checks with one command.

## Requirements

### Requirement: Set up OpenSpec

Init SHALL run `openspec init --tools <tools> .` (default `claude`) in the project root when
`openspec/` does not exist, using `openspec` on PATH or a pinned `@fission-ai/openspec` through npx,
and SHALL leave an existing `openspec/` untouched. `--skip-openspec` skips this step.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: New project

- **WHEN** `specify init` runs where no `openspec/` exists
- **THEN** OpenSpec is initialized and the output reports `openspec: initialized`

#### Scenario: OpenSpec fails

- **WHEN** `openspec init` exits non-zero
- **THEN** init exits 2 and writes no agent instructions

### Requirement: Formal folder

Init SHALL create `formal/` with a short README explaining `Formal:` lines, without overwriting an
existing README.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: Repeated init

- **WHEN** init runs twice
- **THEN** `formal/README.md` keeps any edits from the first run

### Requirement: Managed agent instructions

Init SHALL add or update one `formal-workflow` managed region in AGENTS.md (or `--agents PATH`),
preserve all text outside it, and remove regions written by older Specify versions. The instructions
SHALL cover links, waivers, before models, `Verify:` lines, the gate and the lock.

- Formal: quint formal/ManagedRegion.qnt oneRegion main=ManagedRegion
- Formal: quint formal/ManagedRegion.qnt oneRegion main=ManagedRegionBefore expect=fails
- Verify: test init/Managed agent instructions

#### Scenario: Idempotent

- **WHEN** init runs twice
- **THEN** AGENTS.md contains exactly one `formal-workflow` region

#### Scenario: Legacy region

- **WHEN** AGENTS.md contains a `spec-workflow` region from Specify 0.7
- **THEN** that region is removed and surrounding text is kept

### Requirement: Claude Code skill

When the OpenSpec tools include `claude` (the default) or `all`, init SHALL install the bundled
`specify-formal-properties` skill at `.claude/skills/specify-formal-properties/SKILL.md`, replacing
an older copy.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: Default tools

- **WHEN** `specify init` runs without `--tools`
- **THEN** the skill file exists under `.claude/skills/`

### Requirement: Gate policy file

Init SHALL create `formal/specify.json` when it is absent, with the `strict` policy when init also
initialized OpenSpec and the `warn` policy when `openspec/` already existed, and SHALL leave an
existing file untouched.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: New project

- **WHEN** init runs where no `openspec/` exists
- **THEN** `formal/specify.json` sets `"policy": "strict"`

#### Scenario: Existing project

- **WHEN** init runs where `openspec/` already exists
- **THEN** `formal/specify.json` sets `"policy": "warn"`

### Requirement: Agent Stop hook

When the OpenSpec tools include `claude` or `all`, init SHALL add one Stop hook to
`.claude/settings.json` that runs `gate --hook stop --changed --skip-verify`, preserving every other
setting and updating its own hook in place on later runs.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: Repeated init

- **WHEN** init runs twice
- **THEN** `.claude/settings.json` holds exactly one Specify Stop hook

### Requirement: Pre-push hook

Init SHALL install `.git/hooks/pre-push` running `gate --hook pre-push --changed --skip-verify` when
the project is a git repository with no pre-push hook and no `core.hooksPath`, and SHALL NOT replace
or edit an existing hook.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: Project with its own hook

- **WHEN** a pre-push hook already exists
- **THEN** init leaves it unchanged and reports that the hook was skipped

### Requirement: Agent command

The managed instructions SHALL name the command agents run: `./specify` when the project has that
wrapper, `npx specify` when `package.json` depends on `specify`, and `specify` otherwise.

- Formal: none (file setup behavior, covered by unit tests)

#### Scenario: Global install

- **WHEN** the project has neither the wrapper nor a dependency
- **THEN** the instructions say to run `specify gate`
