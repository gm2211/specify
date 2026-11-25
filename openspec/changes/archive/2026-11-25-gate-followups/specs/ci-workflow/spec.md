## ADDED Requirements

### Requirement: Gate result cache

The workflow SHALL restore and save the gate's cache directory with actions/cache, keyed by the
specify ref, tool versions and a hash of the model files, unless the `cache` input is `false`, in
which case it SHALL pass `--no-cache` to the gate.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Second run of an unchanged model

- **WHEN** a pull request is updated without touching any model
- **THEN** the gate reuses the passing checks cached by the earlier run

### Requirement: Opt-in pull request comment

A separate `gate-comment.yml` workflow, declaring `pull-requests: write`, SHALL post the gate table
(the `specify-gate-table` artifact from `formal.yml`) as one pull request comment and edit it on
later runs. `formal.yml` SHALL keep `permissions: contents: read` and have no comment input.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Updated pull request

- **WHEN** a pull request whose caller uses the comment workflow is pushed to again
- **THEN** the existing gate comment is edited rather than a second one added

#### Scenario: Caller without the comment job

- **WHEN** the caller grants only `contents: read` and does not call the comment workflow
- **THEN** the gate runs as before and no comment is posted
