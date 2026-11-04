# Formal checks for OpenSpec requirements

Specify links Quint models and Lean theorems to OpenSpec requirements and runs them. A link is a
`Formal:` line under the requirement it encodes. The checks say something about the models only: a
model can be internally consistent and still encode the wrong requirement, and it says nothing about
the application unless a conformance test ties the two together.

## Linking a check

```markdown
### Requirement: Resumed worker works again

A worker an operator resumed SHALL work again once any snooze on it lapses.

- Formal: quint formal/snooze.qnt eventuallyWorking temporal main=snoozeResume
- Formal: quint formal/snooze.qnt eventuallyWorking temporal main=snoozeBefore expect=fails

#### Scenario: Resume after snooze

- **WHEN** an operator resumes a snoozed worker
- **THEN** it works again once the snooze lapses
```

Grammar, one check per line, whitespace separated (paths cannot contain spaces):

```text
Formal: quint <file> <property> [invariant|temporal] [expect=holds|fails]
              [backend=tlc|apalache] [mode=verify|simulate] [main=<module>]
              [max-steps=N] [samples=N] [seed=N]
Formal: lean  <file> <Namespace.theorem>
```

Write each link as its own list item (`- Formal: …`). Plain consecutive lines are one Markdown
paragraph, and formatters such as Prettier join them; Specify reports joined links as invalid rather
than guessing. Bold (`**Formal:** …`) and backtick-wrapped links also work. Lines inside fenced code
blocks are ignored. A line outside a requirement, or one with an unknown or inapplicable option, is
reported as an invalid check and fails the run.

| Option                   | Default         | Meaning                                                                                      |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `invariant` / `temporal` | `invariant`     | Quint `--invariant` or `--temporal`                                                          |
| `expect`                 | `holds`         | `fails` marks a "before" model or mutation that must produce a counterexample                |
| `backend`                | `tlc`           | `tlc` explores every reachable state; `apalache` is bounded by `max-steps`                   |
| `max-steps`              | `10` (Apalache) | Not allowed with TLC                                                                         |
| `mode=simulate`          |                 | Random traces with Quint's own runner; needs `max-steps`, `samples`, `seed`; invariants only |
| `main`                   | file name       | Quint module to check, for files with several modules                                        |

Lean links accept `expect=holds` only.

## Why `expect=fails`

A property that can never fail passes every check. For each property that must hold, keep a "before"
model (the design with the bug) or a deliberate mutation, and link it with `expect=fails`. If
someone later weakens the property, the before model stops failing and `formal check` fails.

## Running

```bash
specify formal check                      # JSON when piped, a table on a terminal
specify formal check --format text        # requirement → result table
specify formal check --tool quint         # only Quint links
specify formal check --change add-cap     # include an OpenSpec change's delta specs
specify formal check --root path/to/repo --timeout-ms 300000 \
  --quint-bin quint --lean-bin /path/to/lean
```

The command exits 0 only when at least one check ran and every check matched its expectation.
Requirements without a `Formal:` line are listed so missing coverage stays visible.

With `--change <name>`, requirements that the change adds or modifies replace the main spec's links,
and requirements it removes disappear from the report. Use it to check a proposal before
`openspec archive`.

For a Lean project with imports, run through Lake so the caller's compiled dependencies are found:

```bash
lake env specify formal check --tool lean
```

## CI

```yaml
jobs:
  formal:
    uses: gm2211/specify/.github/workflows/formal.yml@v0.8.1
    with: # all optional
      root: .
      tools: quint,lean
      change: '' # an OpenSpec change to include
      specify-ref: v0.8.1 # keep equal to the tag above
```

The workflow installs Specify from GitHub, Quint from the npm registry tarball (sha512 checked),
Apalache (which also provides TLC, sha256 checked), Java 21 and Lean from its release archive
(sha256 checked). If the root has a `lakefile`, it runs `lake build` and checks under `lake env`.
The requirement → result table goes to the log and the job summary. To change a tool version,
override the version and its checksum inputs together.

## Tools

Install the tools yourself; Specify does not download them. TLC and Apalache need Java 17 or newer.
Quint may download Apalache or TLC jars on first use. Apalache may bind a temporary server; run
checks only on trusted models and in an environment whose network exposure is acceptable.

Lean checks compile the named file and inspect the theorem's transitive axioms. `propext`,
`Classical.choice` and `Quot.sound` are accepted; `sorry` and custom axioms fail.

Validated with Quint 0.33.1 (Apalache 0.62.4; TLC and Apalache backends) and Lean 4.35.0.
Unrecognized tool output is reported as an error, never as a pass.

## Example

[`examples/counter`](../examples/counter) has an OpenSpec spec with invariant, temporal, bounded,
simulated and Lean links, including before models that must fail:

```bash
specify formal check --root examples/counter --tool quint --format text
```
