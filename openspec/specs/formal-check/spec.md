# formal-check Specification

## Purpose

`specify formal check` runs the Quint and Lean checks that OpenSpec requirements link with `Formal:`
lines, and reports each requirement's result. It checks authored models only.

## Requirements

### Requirement: Formal lines link checks to requirements

The checker SHALL read `Formal:` lines written under `### Requirement:` headings in
`openspec/specs/**/spec.md`, identify each by `<capability>/<requirement name>`, and resolve model
paths relative to the project root.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Waiver

- **WHEN** a requirement contains `Formal: none (covered by tests)`
- **THEN** the report counts it as waived and runs no check for it

#### Scenario: Linked requirement

- **WHEN** a requirement contains `Formal: quint formal/c.qnt safe`
- **THEN** the report lists a check for that requirement against `formal/c.qnt`

#### Scenario: Invalid or stray line

- **WHEN** a `Formal:` line cannot be parsed or sits outside a requirement
- **THEN** the report shows it as an error and the run fails

#### Scenario: Fenced examples

- **WHEN** a `Formal:` line appears inside a fenced code block
- **THEN** it is ignored

### Requirement: OpenSpec change overlay

With `--change <name>`, the checker SHALL also read `openspec/changes/<name>/specs/**/spec.md`:
requirements the change adds or modifies replace the main spec's links for the same requirement, and
requirements under `## REMOVED Requirements` are dropped from the report.

- Formal: quint formal/Overlay.qnt overlaySound main=Overlay
- Formal: quint formal/Overlay.qnt overlaySound main=OverlayBefore expect=fails
- Verify: test formal-check/OpenSpec change overlay

#### Scenario: Modified requirement

- **WHEN** a change modifies a requirement and gives it a new `Formal:` link
- **THEN** only the change's link runs for that requirement

#### Scenario: Unsafe change name

- **WHEN** the change name contains a path separator
- **THEN** the command is rejected

### Requirement: Expected outcomes

Each link SHALL declare `expect=holds` (default) or `expect=fails`, and a check SHALL count as
passing only when the observed result equals its expectation. Lean links SHALL accept `expect=holds`
only.

- Formal: quint formal/Verdict.qnt errorNeverPasses main=Verdict
- Formal: quint formal/Verdict.qnt errorNeverPasses main=VerdictBefore expect=fails
- Verify: test formal-check/Expected outcomes

#### Scenario: Before model keeps failing

- **WHEN** a link with `expect=fails` finds a counterexample
- **THEN** that check passes

#### Scenario: Before model stops failing

- **WHEN** a link with `expect=fails` finds no violation
- **THEN** that check fails and the report says the before model no longer shows the bug

### Requirement: Invariant and temporal Quint properties

Quint links SHALL check either an invariant (default, `--invariant`) or a temporal property
(`temporal`, `--temporal`). Temporal properties SHALL require `mode=verify`.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Liveness with fairness

- **WHEN** a link reads `Formal: quint formal/s.qnt eventuallyDone temporal`
- **THEN** Quint runs with `--temporal eventuallyDone`

### Requirement: Quint backends

Verification SHALL use TLC by default, which explores every reachable state, or Apalache with
`backend=apalache`, bounded by `max-steps` (default 10). `mode=simulate` SHALL use Quint's own
runner and require `max-steps`, `samples` and `seed`. Options that do not apply to the chosen
backend or mode SHALL be rejected. The report labels evidence as exhaustive, bounded, simulation, or
proof.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Step bound on TLC

- **WHEN** a TLC link sets `max-steps`
- **THEN** the line is rejected as invalid

### Requirement: Lean theorems

Lean links SHALL compile the named file and inspect the public theorem and its transitive axioms;
`sorry` and custom axioms fail, while `propext`, `Classical.choice` and `Quot.sound` are allowed.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Proof with sorry

- **WHEN** the theorem depends on `sorryAx`
- **THEN** the check fails

### Requirement: Report and exit status

The command SHALL print a requirement-to-result table for text output and a JSON summary otherwise,
list requirements without `Formal:` lines, and exit 0 only when at least one check ran and every
check matched its expectation.

- Formal: quint formal/Verdict.qnt noVacuousPass main=Verdict
- Formal: quint formal/Verdict.qnt noVacuousPass main=VerdictBefore expect=fails
- Verify: test formal-check/Report and exit status

#### Scenario: No links

- **WHEN** no requirement has a `Formal:` line
- **THEN** the command exits 1 rather than reporting a vacuous pass

#### Scenario: Filter by tool

- **WHEN** `--tool quint` is passed
- **THEN** only Quint links run

### Requirement: Caller-owned tools

The checker SHALL invoke caller-provided `quint` and `lean` executables without downloading them and
without a sandbox. Lean project dependencies stay caller-managed.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Tool missing

- **WHEN** `quint` is not on PATH
- **THEN** its checks report `unavailable` and the run fails

### Requirement: Evidence boundary

Results SHALL be labeled `formal-models-only`. A passing check MUST NOT be presented as proof that
the model matches the requirement prose or that the application satisfies the model.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: All checks pass

- **WHEN** every check matches its expectation
- **THEN** the text report states the results cover the formal models only
