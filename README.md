# Specify

A spec-driven development gate for [OpenSpec](https://github.com/Fission-AI/OpenSpec). Write
requirements in OpenSpec, link a Quint model or Lean theorem under each one with a `Formal:` line,
tie the model to the code with a `Verify:` line, and let one command decide whether the work may
land. Agents, git hooks and CI all run that command.

## Set up a project

```bash
npm install --global https://github.com/gm2211/specify/releases/download/v0.9.0/specify-0.9.0.tgz
specify init    # openspec init, formal/, gate policy, AGENTS.md, Claude Code skill and hooks
specify gate    # checks, coverage policy, Verify test results and the drift lock
```

Then add CI, which installs checksum-pinned Quint, TLC/Apalache and Lean, runs the gate against the
base branch, and puts the result table in the job summary:

```yaml
jobs:
  formal:
    uses: gm2211/specify/.github/workflows/formal.yml@v0.9.0
```

The npm package named `specify` is unrelated; install from the GitHub release as above, or in a Node
project as a dev dependency: `npm install --save-dev github:gm2211/specify#v0.9.0`. Bumping the tag
is how a project picks up a new Specify.

## What a link looks like

```markdown
### Requirement: Count reaches the cap

The counter SHALL reach its cap when steps keep being taken.

- Formal: quint formal/Counter.qnt reachesCap temporal main=Counter
- Formal: quint formal/Counter.qnt reachesCap temporal main=CounterBefore expect=fails
```

```text
| Requirement                   | Check                                            | Expect | Result |   |
| counter/Count reaches the cap | quint reachesCap in Counter (temporal, tlc)       | holds  | holds  | ✓ |
| counter/Count reaches the cap | quint reachesCap in CounterBefore (temporal, tlc) | fails  | fails  | ✓ |
```

```markdown
### Requirement: Lease is exclusive

- Formal: quint formal/lease.qnt exclusive
- Formal: quint formal/lease.qnt exclusive main=LeaseBefore expect=fails
- Verify: test lease/Lease is exclusive

### Requirement: CSV export has a header row

- Formal: none (pure input/output, covered by tests)
```

```text
| Requirement                      | Model  | Before model | Test  |
| lease/Lease is exclusive         | 1/1 ✓  | 1/1 ✓        | 1/1 ✓ |
| export/CSV export has a header   | waived | -            | -     |
Gate open: 2/2 checks as expected, 1 waived, policy strict.
```

## What the gate enforces

Under the `strict` policy (the default for new projects; existing projects start with `warn`):

- **Coverage**: every requirement has a `Formal:` link or a `Formal: none (reason)` waiver.
- **Non-vacuity**: every Quint property that must hold is also linked with `expect=fails` on a
  "before" model, so a property that can never fail is caught.
- **Model to code**: every modeled requirement names a test with `Verify:`, and that test passed in
  the project's own JUnit or TAP report. `specify trace export` writes the model's traces for the
  test to replay. Specify reads reports; it never runs tests.
- **No silent weakening**: `formal/specify.lock` records every link and a hash of its property.
  Removing a link, flipping `expect` or editing a property fails against the base branch unless an
  OpenSpec change proposal names the requirement.
- **Agents cannot stop on red**: `specify init` installs a Claude Code Stop hook and a pre-push hook
  that run the gate on changed models.

## What a check can be

- **Invariants and temporal properties**, checked by TLC (every reachable state) by default, or by
  Apalache (bounded) or random simulation.
- **`expect=fails`** keeps a "before" model that must produce a counterexample, so a property that
  can never fail is caught.
- **Lean theorems**, accepted only with standard axioms (no `sorry`).
- **OpenSpec changes**: the gate checks every active change's delta specs before archive.
- **Counterexamples**: a failing property prints the states that lead to the violation.
- **A Claude Code skill** (`specify-formal-properties`) that `specify init` installs, covering when
  to model a requirement, Quint vs Lean, fairness, before models and conformance tests.

Results cover the models only, not the application; tie models to code with conformance tests. See
[formal checks and the gate](docs/formal.md) for the full syntax and
[migration notes](docs/migration-0.8.md) if you used Specify 0.7's own spec format.

## Develop

```bash
npm ci && npm run quality && npm test
./specify gate --format text   # needs quint on PATH and reports/junit.xml from the tests
```
