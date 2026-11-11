# product-direction Specification

## Purpose

Specify's own product decisions, with the user's exact wording where it was recorded.

## Requirements

### Requirement: OpenSpec formal companion

Specify SHALL be a small formal-check companion to OpenSpec: OpenSpec owns the spec format, and
Specify owns linking requirements to Quint and Lean checks, running them, and project setup.

Source (2026-11-04, approving the plan "OpenSpec plus a small formal checker"): "so turn specify
into this? how do I replicate this setup across all projects" and "tell the specify coordinator to
do it".

- Formal: none (product decision)

#### Scenario: Removed surface

- **WHEN** a user runs a 0.7 command such as `spec lint`, `view` or `mcp`
- **THEN** Specify exits with an error pointing to the 0.8 migration notes

#### Scenario: New project

- **WHEN** a user wants requirements with formal checks in a new repository
- **THEN** they run `specify init` and add `Formal:` lines under OpenSpec requirements

### Requirement: Enforce spec-driven development

Specify SHALL enforce spec-driven development rather than only report on it: one gate covers the
chain from requirement to model to test, and agents, git hooks and CI run it. Specify SHALL read a
project's test reports and MUST NOT run application tests. New projects start `strict`; existing
ones start `warn`.

- Formal: none (product decision)

#### Scenario: Source of the decision

- **WHEN** a reader asks why Specify gates work
- **THEN** the record is the request of 2026-11-11, "figure out the current usefulness of this and
  how we could turn this more and more into something of a useful companion to enforce
  spec-driven-development and formal validation", followed by "implement plan" in reply to the
  roadmap that recommended reading test reports without running tests, and strict for new projects

#### Scenario: Agent weakens a property

- **WHEN** an agent edits a linked property without an OpenSpec change proposal
- **THEN** the strict gate fails in the agent's Stop hook and in CI

### Requirement: Encode properties formally

Specify SHALL help coding agents encode intended properties in Quint or Lean and keep them linked to
the requirement they represent.

Source (2026-10-03): "also I wanted it to be a companion that helped encode properties in formal
validation languages like quint.sh or Lean".

- Formal: none (product decision)

#### Scenario: Agent adds a property

- **WHEN** an agent writes a Quint property for a requirement
- **THEN** it links it with a `Formal:` line and a before model with `expect=fails`

### Requirement: Same setup across projects

Every project SHALL be able to adopt the same setup with `specify init` plus a shared CI workflow,
so a Specify version bump updates all of them.

Source (2026-11-04): "how do I replicate this setup across all projects". Delivered in 0.8.2 as
`specify init` plus the reusable workflow `formal.yml`. Specify installs from GitHub because the npm
name `specify` belongs to someone else.

- Formal: none (product decision)

#### Scenario: Version bump

- **WHEN** Specify releases a new version
- **THEN** projects pick it up without copying runner code

### Requirement: Results visible in a UI

Specify SHALL let users see formal results per requirement: the `gate` table locally and in the
GitHub job summary of the reusable workflow. A UI next to OpenSpec's requirement views is not built.

Source (2026-10-04): "I want all my projects and all the users of specify to seamlessly be able to
get a ui to see the spec". The bundled viewer was removed with Specify's own spec format; the CI job
summary is the shared view for now.

- Formal: none (product decision)

#### Scenario: Reading results today

- **WHEN** a user runs `specify gate --format text` or opens the CI job summary
- **THEN** they see one row per requirement
