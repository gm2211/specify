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

When the `pr-comment` input is `true` (default `false`) on a pull request, the workflow SHALL post
the gate table as one comment and update that comment on later runs. The workflow SHALL NOT declare
`pull-requests: write`; the caller grants it, and a failure to comment SHALL NOT fail the job.
Callers that grant only `contents: read` SHALL keep working unchanged.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Read-only caller

- **WHEN** the caller grants only `contents: read`
- **THEN** the gate runs as before and no comment is posted
