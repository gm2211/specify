# Formal models

Quint models and Lean proofs for the requirements in `openspec/specs/`. Link each one from the
requirement it encodes, one list item per check:

    - Formal: quint formal/example.qnt someInvariant
    - Formal: quint formal/example.qnt eventuallyDone temporal expect=holds
    - Formal: quint formal/example_before.qnt eventuallyDone temporal expect=fails
    - Formal: lean formal/Example.lean Example.someTheorem
    - Formal: none (pure input/output, covered by tests)
    - Verify: test <name of the conformance test>

`specify.json` sets the gate policy (`strict` or `warn`) and the test reports to read.
`specify.lock` records every link; update it with `specify lock` and commit it. Run `specify gate`
from the project root.
