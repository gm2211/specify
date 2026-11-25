## ADDED Requirements

### Requirement: Passing checks are cached

The gate SHALL reuse a passing check's stored outcome (under `.specify/cache/gate`) instead of
running the tool, while the check, the model files and the tool's `--version` output are unchanged.
Failing checks SHALL always re-run, an unreadable tool version SHALL disable caching, and
`--no-cache` SHALL bypass it.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Unchanged model

- **WHEN** the gate runs twice on the same models and tool version
- **THEN** the second run reports its passing checks as reused from the cache

### Requirement: Checks run concurrently

The gate SHALL run up to `--jobs` checks at the same time (default 1, serial) and report them in
link order.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Mixed results

- **WHEN** one of several concurrent checks fails
- **THEN** each result is reported at its link's position

## MODIFIED Requirements

### Requirement: Drift lock

`specify lock` SHALL write `formal/specify.lock` with each main-spec requirement's waiver, or each
link's identity, expectation and a hash of the linked property's text. For a Quint `val`, `def` or
`temporal`, that text is the whole definition, up to the next declaration at the same nesting level,
including blank lines and nested declarations inside its body. The gate SHALL report a lock that is
missing or differs from the specs.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Edit after a blank line

- **WHEN** a property's definition has several paragraphs and only a later paragraph is edited
- **THEN** the property's hash in the lock changes
