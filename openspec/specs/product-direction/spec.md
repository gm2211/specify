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

#### Scenario: Removed surface

- **WHEN** a user runs a 0.7 command such as `spec lint`, `view` or `mcp`
- **THEN** Specify exits with an error pointing to the 0.8 migration notes

#### Scenario: New project

- **WHEN** a user wants requirements with formal checks in a new repository
- **THEN** they run `specify init` and add `Formal:` lines under OpenSpec requirements

### Requirement: Encode properties formally

Specify SHALL help coding agents encode intended properties in Quint or Lean and keep them linked to
the requirement they represent.

Source (2026-10-03): "also I wanted it to be a companion that helped encode properties in formal
validation languages like quint.sh or Lean".

#### Scenario: Agent adds a property

- **WHEN** an agent writes a Quint property for a requirement
- **THEN** it links it with a `Formal:` line and a before model with `expect=fails`

### Requirement: Same setup across projects

Every project SHALL be able to adopt the same setup with `specify init` plus a shared CI workflow,
so a Specify version bump updates all of them.

Source (2026-11-04): "how do I replicate this setup across all projects". Delivered in 0.8.1 as
`specify init` (OpenSpec, `formal/`, AGENTS.md, Claude Code skill) plus the reusable workflow
`gm2211/specify/.github/workflows/formal.yml`. Specify installs from GitHub because the npm package
named `specify` belongs to someone else.

#### Scenario: Version bump

- **WHEN** Specify releases a new version
- **THEN** projects pick it up without copying runner code

### Requirement: Results visible in a UI

Specify SHALL let users see formal results per requirement: the `formal check` table locally and the
same table in the GitHub job summary of the reusable workflow. A UI next to OpenSpec's own
requirement views is not built.

Source (2026-10-04): "I want all my projects and all the users of specify to seamlessly be able to
get a ui to see the spec". The bundled viewer that served this was removed with Specify's own spec
format; the CI job summary is the shared view of formal results for now.

#### Scenario: Reading results today

- **WHEN** a user runs `specify formal check --format text` or opens the CI job summary
- **THEN** they see one row per requirement and check
