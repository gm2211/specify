---
name: specify-formal-properties
description:
  Write and check Quint or Lean properties for OpenSpec requirements with Specify. Use when a
  requirement involves state, concurrency, retries, ordering, permissions or liveness and should be
  model-checked, or when adding, changing or debugging a `Formal:` link or a `specify formal check`
  failure.
---

# Formal properties for OpenSpec requirements

Specify links formal models to OpenSpec requirements and runs them. Requirements live in
`openspec/specs/<capability>/spec.md`; models and proofs live in `formal/`. A passing check is a
statement about the model only. Your job is to make the model faithful, make the property
non-vacuous, and tie the model to the code.

## 1. Decide whether a requirement needs a model

Model a requirement when bugs would come from interleavings or long histories: state machines,
retries and timeouts, locks and leases, queues, permissions that change over time, "eventually"
promises. Skip pure input/output behavior; ordinary tests cover it better.

Pick the tool:

| Need                                                      | Tool                      | Link                                             |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------ |
| Something bad never happens (safety)                      | Quint invariant           | `- Formal: quint formal/x.qnt safe`              |
| Something good eventually happens (liveness)              | Quint temporal + fairness | `- Formal: quint formal/x.qnt progress temporal` |
| A property of a function or data structure for all inputs | Lean theorem              | `- Formal: lean formal/X.lean X.theorem`         |

## 2. Write the Quint model

- Start from the requirement text and its scenarios. List every assumption the model makes in a
  comment at the top (bounds, which actors exist, what the environment may do).
- Keep state finite: small constants (`pure val MAX = 3`), bounded sets. TLC, the default backend,
  explores every reachable state and must terminate.
- Model the environment's freedom honestly: crashes, duplicate or reordered messages, an attacker's
  actions. A model that leaves them out proves less than it appears to.
- One action per real operation, combined in `step` with `any { ... }`.
- Invariants are `val`; temporal properties are `temporal` and almost always need fairness:
  `temporal progress = weakFair(step, vars) implies eventually(done)`. Without fairness, stuttering
  forever is a legal behavior and every "eventually" fails.

## 3. Make the property non-vacuous

A property that can never fail passes every check. For each property that must hold, keep a "before"
model that must fail:

- If you are fixing a bug, model the old behavior in a second module (e.g. `CounterBefore`) and link
  it with `expect=fails`. This proves the property catches the bug.
- Otherwise, add a module with one deliberate mutation (drop a guard, skip a step) and link it with
  `expect=fails`.

```markdown
### Requirement: Resumed worker works again

...

- Formal: quint formal/snooze.qnt eventuallyWorking temporal main=Snooze
- Formal: quint formal/snooze.qnt eventuallyWorking temporal main=SnoozeBefore expect=fails
```

Never flip `expect`, weaken a property, or shrink constants just to make a check pass. If a check
fails, either the model or the code is wrong; find out which.

## 4. Link and run

- One list item per link, under the `### Requirement:` it encodes. Plain consecutive lines get
  joined by Markdown formatters, and Specify rejects joined links.
- Options: `invariant|temporal`, `expect=holds|fails`, `backend=tlc|apalache` (Apalache needs
  `max-steps=N`), `mode=simulate max-steps=N samples=N seed=N` for quick random traces,
  `main=<module>`.
- Run `specify formal check --format text`. Use `--tool quint` while iterating, and
  `--change <name>` to check a pending OpenSpec change's delta specs.
- Read a counterexample from the trace Quint prints: it is a sequence of states leading to the
  violation. Explain it in plain words before changing anything.

## 5. Tie the model to the code

The model and the code drift unless a test pins them together. For each model, add a conformance
test in the project's normal test suite that replays the model's key scenarios (or a trace Quint
produced with `--out-itf`) against the real implementation. Name the requirement in the test name so
a reader can follow requirement → model → test.

## 6. Lean theorems

- State the theorem with explicit premises; keep it public and fully qualified.
- `sorry` and custom axioms fail the check; `propext`, `Classical.choice` and `Quot.sound` are
  allowed.
- For a Lake project, run `lake build` first and then `lake env specify formal check --tool lean`.
