# gate Specification

## Purpose

`specify gate` gives one verdict over the chain from requirement to model to test: formal checks,
the coverage policy, `Verify:` test results and the drift lock. Agents, git hooks and CI all run the
same command.

## Requirements

### Requirement: Coverage policy

The gate SHALL report a finding for every requirement that has neither a `Formal:` link nor a
`Formal: none (<reason>)` waiver, and for every requirement that has both. A waiver without a reason
SHALL be an invalid line.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Unlinked requirement under the strict policy

- **WHEN** a requirement has no `Formal:` line and the policy is `strict`
- **THEN** the gate fails and names the requirement

#### Scenario: Waived requirement

- **WHEN** a requirement carries `Formal: none (pure input/output, covered by tests)`
- **THEN** the gate reports it as waived and raises no finding for it

### Requirement: Before models are required

For every Quint property a requirement expects to hold, the gate SHALL report a finding unless the
same requirement links the same property with `expect=fails`.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Property that cannot be shown to fail

- **WHEN** a requirement links `safe` with `expect=holds` only
- **THEN** the gate reports that `safe` has no `expect=fails` link

### Requirement: Policy strictness

The gate SHALL read the policy from `formal/specify.json` (`strict` or `warn`; `warn` when the file
is absent), overridable with `--policy`. Policy findings, failing `Verify:` results and lock
problems SHALL fail the gate under `strict` and be warnings under `warn`. Failed checks and invalid
lines SHALL fail under either policy.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Existing project

- **WHEN** a project has no `formal/specify.json` and one unlinked requirement
- **THEN** the gate lists the requirement as a warning and still passes when every check passes

#### Scenario: Nothing linked

- **WHEN** requirements exist but none has a link or a waiver
- **THEN** the gate fails under either policy

### Requirement: Verify links read test reports

A `Verify: test <name>` line SHALL pass only when the project's test reports (JUnit XML or TAP, from
`testReports` or `--test-report`) hold a test case whose name contains `<name>`, with at least one
match passed and none failed. Every requirement with a formal link SHALL have a `Verify:` line.
Specify MUST NOT run tests itself; `--skip-verify` leaves test results out of the verdict.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Linked test is missing

- **WHEN** no test case in the reports matches a `Verify:` name
- **THEN** that link is reported as `missing`

#### Scenario: No report

- **WHEN** no configured report file exists
- **THEN** every `Verify:` link is reported as `no-report`

### Requirement: Drift lock

`specify lock` SHALL write `formal/specify.lock` with each main-spec requirement's waiver, or each
link's identity, expectation and a hash of the linked property's text. The gate SHALL report a lock
that is missing or differs from the specs.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Links changed without relocking

- **WHEN** a `Formal:` line is added and `specify lock` is not run
- **THEN** the gate reports that the lock does not match the specs

### Requirement: Weakening needs a change proposal

The gate SHALL compare the specs with the lock at the base ref (`--base`, default `HEAD`). A removed
requirement or link, links replaced by a waiver, a flipped expectation, or an edited property SHALL
be a weakening unless an active OpenSpec change, or a change archived in the same diff, names that
requirement.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Flipped expectation

- **WHEN** a link's `expect=holds` becomes `expect=fails` with no change proposal
- **THEN** the strict gate fails with `expect-flipped` for that requirement

#### Scenario: Covered by a proposal

- **WHEN** an active change's delta spec names the requirement whose property was edited
- **THEN** the gate reports the change as covered and does not fail for it

### Requirement: Active changes are checked

The gate SHALL run the `Formal:` links in the delta specs of every active OpenSpec change (each
directory under `openspec/changes` except `archive`) and apply the policy to each change's overlay,
without a `--change` option.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Pending proposal

- **WHEN** an active change adds a requirement with a `Formal:` link
- **THEN** the gate runs that link and labels the result with the change's name

### Requirement: Changed-only runs

With `--changed`, the gate SHALL run only the links whose spec file or model file differs from the
base ref or is uncommitted, and SHALL still apply the policy and the lock to every requirement.
Outside a git work tree it SHALL run every link.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Nothing changed

- **WHEN** no spec or model file differs from the base ref
- **THEN** no check runs and the gate reports how many were skipped

### Requirement: Hook mode

With `--hook stop` or `--hook pre-push`, the gate SHALL write its report to standard error only when
it fails, SHALL NOT fail for a check whose tool is not installed, and SHALL exit 2 for `stop` and 1
for `pre-push` on failure. For `stop`, it SHALL exit 0 without checking when the hook input on
standard input has `stop_hook_active` set, so an agent is sent back at most once per attempt to
finish.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Agent finishes on a red gate

- **WHEN** an agent tries to stop while a changed model's check fails
- **THEN** the Stop hook exits 2 and the agent receives the report

### Requirement: Counterexamples are shown

When a property expected to hold fails, the text report SHALL include the counterexample states the
tool printed, and the JSON result SHALL carry them as `trace`.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Violated invariant

- **WHEN** TLC finds a counterexample for a `holds` link
- **THEN** the report shows the states leading to the violation under that requirement

### Requirement: Trace export

`specify trace export` SHALL write ITF traces of every Quint model that a requirement expects to
hold into `formal/traces/<module>/`, sampled with a fixed seed and without timestamps, so
conformance tests can replay them against the implementation and the files can be committed.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Reproducible traces

- **WHEN** `trace export` runs twice with the same seed on an unchanged model
- **THEN** it writes identical files

### Requirement: Traceability report

The gate's text output SHALL show one row per requirement with its model checks, its before models
and its `Verify:` tests, followed by every reason the gate is closed, and SHALL state that results
cover the formal models only.

- Formal: none (input/output behavior, covered by unit tests)

#### Scenario: Reading the verdict

- **WHEN** a user runs `specify gate --format text`
- **THEN** each requirement appears once with model, before-model and test columns
