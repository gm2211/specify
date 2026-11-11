# Formal checks and the gate

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
specify gate                              # the full verdict; see "The gate" below
specify formal check                      # only the checks: JSON when piped, a table on a terminal
specify formal check --format text        # requirement → result table
specify formal check --tool quint         # only Quint links
specify formal check --change add-cap     # include an OpenSpec change's delta specs
specify formal check --root path/to/repo --timeout-ms 300000 \
  --quint-bin quint --lean-bin /path/to/lean
```

`formal check` exits 0 only when at least one check ran and every check matched its expectation.
Requirements without a `Formal:` line are listed so missing coverage stays visible. When a property
expected to hold fails, the report prints the counterexample states.

## The gate

`specify gate` is the command agents, hooks and CI run. It runs every link in the main specs and in
each active OpenSpec change, then applies four rules. `formal/specify.json` sets how strictly:

```json
{ "policy": "strict", "testReports": ["reports/junit.xml"] }
```

| Rule                 | Fails when                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Coverage             | A requirement has neither a `Formal:` link nor a waiver, or has both                        |
| Before models        | A Quint property with `expect=holds` has no `expect=fails` link in the same requirement     |
| Model tied to a test | A modeled requirement has no `Verify:` line, or its test is missing, skipped or red         |
| Drift lock           | `formal/specify.lock` is missing or stale, or a link was weakened without a change proposal |

Under `strict` each rule fails the gate. Under `warn` (the default without a config file) they are
listed as warnings; failed checks and invalid lines fail under either policy. `specify init` writes
`strict` for a new project and `warn` for one that already had `openspec/`.

```bash
specify gate --format text                 # traceability table, then every reason it is closed
specify gate --changed                     # only links whose spec or model differs from the base
specify gate --base origin/main            # compare the lock with another ref (default HEAD)
specify gate --skip-verify                 # leave test results out (before the tests have run)
specify gate --test-report a.xml,b.tap     # instead of testReports in the config
specify gate --policy warn
```

### Waivers

Not every requirement should be modeled. Say so explicitly, with a reason:

```markdown
- Formal: none (pure input/output, covered by tests)
```

### Verify lines and test reports

```markdown
- Verify: test lease/Lease is exclusive
```

The link passes when a test case whose name contains that text passed, and none with that text
failed, in the JUnit XML or TAP files listed in `testReports`. Put the requirement id in the test
name. Specify never runs your tests: have the test run write a report first (for Node's runner,
`node --test --test-reporter=junit --test-reporter-destination=reports/junit.xml`; the directory
must exist).

A conformance test should replay what the model does. `specify trace export` samples traces from
every Quint model that a requirement expects to hold and writes them as
[ITF](https://apalache-mc.org/docs/adr/015adr-trace.html) JSON under `formal/traces/<module>/`. The
seed is fixed and timestamps are removed, so the files are reproducible; commit them, and keep them
out of formatters. The test reads each state and asserts the implementation agrees. See
`src/formal/conformance.test.ts` in this repository for three examples.

```bash
specify trace export --traces 10 --max-steps 20 --seed 1
```

### The drift lock

`specify lock` writes `formal/specify.lock`: for each requirement its waiver, or each link with its
expectation and a hash of the property's text. Commit it. The gate fails when the lock does not
match the specs, and compares the specs with the lock at the base ref. Each of these is a weakening:

- a requirement or link that had a check is removed (`requirement-removed`, `link-removed`),
- links are replaced by a waiver (`waived`),
- `expect` changes (`expect-flipped`),
- the property's text changes (`definition-changed`; an edit cannot be told apart from a weakening).

A weakening is allowed only when an active OpenSpec change, or one archived in the same diff, names
the requirement in its delta specs. That turns "the agent quietly relaxed the property" into a
proposal a person reviews. Locally the base is `HEAD`, so uncommitted weakening is caught; CI passes
the pull request's base branch, so committing does not hide it.

### Hooks

`specify init` installs two hooks that run `gate --changed --skip-verify`:

- A Claude Code Stop hook in `.claude/settings.json` (`--hook stop`). When the gate is closed it
  exits 2 and the agent receives the report and keeps working. It blocks once per attempt to finish,
  so an agent cannot loop forever on a failure it cannot fix; CI remains the hard gate.
- `.git/hooks/pre-push` (`--hook pre-push`), only when the project has no pre-push hook and no
  `core.hooksPath`. Otherwise add the command to your own hook.

In hook mode a check whose tool is not installed is a warning, not a failure.

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
    uses: gm2211/specify/.github/workflows/formal.yml@v0.9.0
    with: # all optional
      root: .
      tools: quint,lean
      policy: '' # strict or warn; empty uses formal/specify.json
      test-reports-artifact: '' # artifact holding the reports that Verify lines read
      test-reports-path: reports # where it is extracted, under the root
      specify-ref: v0.9.0 # keep equal to the tag above
```

The workflow installs Specify from GitHub, Quint from the npm registry tarball (sha512 checked),
Apalache (which also provides TLC, sha256 checked), Java 21 and Lean from its release archive
(sha256 checked). If the root has a `lakefile`, it runs `lake build` and checks under `lake env`.
The workflow runs `specify gate`, with the pull request's base branch as `--base`, and writes the
table and failures to the log and the job summary. To change a tool version, override the version
and its checksum inputs together.

For `Verify:` lines, upload the test report from your test job and name the artifact:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test # writes reports/junit.xml
      - uses: actions/upload-artifact@v4
        with: { name: test-reports, path: reports/junit.xml }
  gate:
    needs: test
    uses: gm2211/specify/.github/workflows/formal.yml@v0.9.0
    with: { test-reports-artifact: test-reports }
```

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
