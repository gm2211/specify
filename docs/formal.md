# Linked formal models

Behaviors may link small models or theorems in Quint and Lean. The links make selected properties
reviewable and runnable alongside their plain-language requirement. They do not translate prose into
logic, detect natural-language conflicts, or verify the application. A model can be internally
consistent and still encode the wrong requirement; application tests and review remain separate.

## Agent authoring workflow

Start from an existing behavior ID and its recorded user wording. List the assumptions needed to
make that requirement precise; label unresolved assumptions as proposals rather than requirements.
For stateful behavior, write a Quint model with initial states, allowed transitions, and an
invariant. For a mathematical property, state a Lean theorem with explicit premises and supply its
proof.

Review which parts of the requirement the property covers. The counter example below checks
nonnegativity, but that invariant alone does not establish that each increment adds exactly one. Add
a separate property when that guarantee matters. Keep application smoke and regression tests linked
to the same behavior through the project's existing testing workflow.

Run the native check, then deliberately violate the property in a temporary copy to confirm a
counterexample or proof failure is detected. Restore the intended source and rerun. When behavior
changes, review its linked models alongside code and tests; never weaken a property merely to turn a
failing check green.

## Linking a property

Put `formal` on a behavior. Paths are relative to the spec directory, or to the parent directory of
a single-file spec. `spec split` rebases these paths so the same model files remain targeted. Keep
each property close to the behavior it represents:

```yaml
areas:
  - id: counter
    name: Counter
    behaviors:
      - id: count-never-negative
        description:
          The counter starts at zero, stays nonnegative, and each increment increases it by one.
        formal:
          - tool: quint
            file: examples/formal/Counter.qnt
            property: nonNegative
            mode: verify
            maxSteps: 8
          - tool: quint
            file: examples/formal/Counter.qnt
            property: nonNegative
            mode: simulate
            maxSteps: 8
            samples: 20
            seed: 17
          - tool: lean
            file: examples/formal/Counter.lean
            property: Counter.incrementPreservesNonnegative
```

Quint references name a property, select `simulate` or bounded `verify`, and set a nonnegative
`maxSteps`. Simulation also requires `samples` and `seed`; verification forbids them. Verification
uses Apalache for an explicit bounded state-space check, not an unbounded proof. Simulation uses
Quint's TypeScript backend and the recorded seed. See the
[Quint language basics](https://quint.sh/docs/language-basics) and
[model checker overview](https://quint.sh/docs/model-checkers) for upstream language and
verification details. Lean references identify a public theorem by its fully qualified name. Private
declarations cannot be checked through this link; see the
[Lean language reference](https://lean-lang.org/doc/reference/latest/) for Lean's theorem and proof
model.

`formal check` evaluates every reference declared in `Behavior.formal`; behavior IDs without formal
links remain visible in its report. A spec with no formal references fails rather than reporting a
vacuous pass. Output labels its evidence as `formal-models-only`.

## Running checks

Install the tools outside Specify and make them available on `PATH`, or select their executables:

```bash
specify formal check --spec specify.spec
specify formal check --spec specify.spec --timeout-ms 90000 \
  --quint-bin quint --lean-bin /path/to/lean
```

For a Lean project with imports, run through Lake from that project's root so the caller's compiled
dependencies are available:

```bash
lake env specify formal check --spec specify.spec
```

Specify does not download tools. Quint may bootstrap its own backend; that tool behavior is outside
Specify's control. Quint's Apalache integration may bind a temporary server to `0.0.0.0` even when
the client uses loopback. Run formal checks only on trusted model/tool inputs and in an environment
whose network exposure is acceptable; Specify does not sandbox these processes.

Lean checks compile the selected file and inspect the named theorem and its transitive axioms.
`propext`, `Classical.choice`, and `Quot.sound` are accepted; `sorry` and custom axioms do not pass.
Specify does not manage or build caller-owned Lean dependencies.

Validated with Quint 0.32.0 (Apalache 0.56.1) and Lean 4.34.1. Upstream CLI or Lean metaprogramming
changes may require adapter updates; unrecognized results fail rather than count as passing checks.

## Example files

The repository includes a small Quint counter model and Lean theorem under
[`src/spec/examples/formal/`](../src/spec/examples/formal/). They demonstrate model-level checks;
they are not connected to or evidence about Specify's running implementation.
