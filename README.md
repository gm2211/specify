# Specify

Formal checks for [OpenSpec](https://github.com/Fission-AI/OpenSpec) requirements. Write
requirements in OpenSpec, link a Quint model or Lean theorem under each one with a `Formal:` line,
and run every linked check with one command.

## Set up a project

```bash
npm install --global github:gm2211/specify#v0.8.1   # the npm package named "specify" is unrelated
specify init           # openspec init, formal/, AGENTS.md instructions, Claude Code skill
specify formal check   # runs every Formal: line and prints requirement → result
```

Then add CI, which installs checksum-pinned Quint, TLC/Apalache and Lean and puts the result table
in the job summary:

```yaml
jobs:
  formal:
    uses: gm2211/specify/.github/workflows/formal.yml@v0.8.1
```

Bumping the tag in that line (and in the install command) is how a project picks up a new Specify.

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

- **Invariants and temporal properties**, checked by TLC (every reachable state) by default, or by
  Apalache (bounded) or random simulation.
- **`expect=fails`** keeps a "before" model that must produce a counterexample, so a property that
  can never fail is caught.
- **Lean theorems**, accepted only with standard axioms (no `sorry`).
- **OpenSpec changes**: `--change <name>` checks a pending change's delta specs before archive.
- **A Claude Code skill** (`specify-formal-properties`) that `specify init` installs, covering when
  to model a requirement, Quint vs Lean, fairness, before models and conformance tests.

Results cover the models only, not the application; tie models to code with conformance tests. See
[formal checks](docs/formal.md) for the full syntax and [migration notes](docs/migration-0.8.md) if
you used Specify 0.7's own spec format.

## Develop

```bash
npm ci && npm run quality && npm test
./specify formal check --root examples/counter --tool quint --format text   # needs quint on PATH
```
