# Formal verification with Quint/TLC

`specify verify --mode formal` owns headless finite-model verification. It reuses
Specify's Quint subprocess boundary and ITF decoder. It does not open a browser,
invoke an LLM, approve draft models in `specify.quint.yaml`, or claim implementation
refinement. Existing browser-model review gates remain unchanged. This mode is an
explicit local check of project-owned source, including drafts; it does not feed
unapproved drafts into browser test generation.

Install your project's pinned Quint CLI and Java 21+. Enable both opt-ins:

```sh
SPECIFY_ENABLE_QUINT_SPECS=1 SPECIFY_ENABLE_QUINT_SYMBOLIC=1 \
  specify verify --mode formal --spec app.spec \
  --formal-manifest app.spec/models/verification.json \
  --quint-binary ./node_modules/.bin/quint --output .specify/formal
```

Use an executable path for `--quint-binary` (or `quint` on PATH). Quint remains an
operator-installed dependency. Specify does not silently install it or downgrade
proof checks to simulation. Quint 0.32.0 and Apalache 0.56.1 were integration-tested;
the manifest pins versions rather than following an ambient latest version.

The version-1 JSON manifest uses paths relative to itself:

```json
{
  "version": 1,
  "quintVersion": "0.32.0",
  "apalacheVersion": "0.56.1",
  "tlcConfig": "tlc.json",
  "timeoutMs": 120000,
  "models": [{
    "id": "scheduler", "file": "scheduler.qnt", "main": "scheduler",
    "behavior": "dispatch/eventual-progress",
    "invariant": "safety", "temporal": ["liveness", "deadlockFreedom"]
  }],
  "controls": [{
    "id": "missing-fairness", "model": "scheduler",
    "invariant": "safety", "temporal": ["unfairLiveness"]
  }],
  "traces": [{
    "id": "scheduler-traces", "model": "scheduler",
    "seed": 42, "count": 8, "maxSteps": 200, "step": "step"
  }]
}
```

Models must be standalone: proof runs copy their source into an isolated temporary
directory. Cross-file relative imports are not supported. Each negative control
may supply `replace: {"from": "guard text", "to": "weakened text"}`; exactly one
occurrence must change. A control can instead check an explicitly unfair property.
All IDs must be unique lowercase letters/digits/hyphens, starting with a letter.
Empty model suites, unknown fields and references are errors. `tlc.json` contains
Quint's TLC configuration, for example
`{"maxHeap":"-Xmx1G","stackSize":"-Xss16m","workers":1}`.

Reports contain per-check verdicts and logs, exact inputs and tool evidence.
Only exhaustive TLC success passes a positive check. Only a real counterexample
passes a negative control. A timeout, missing executable, syntax error or truncated
output is an error. Liveness is conditional on the model's fairness/environment
assumptions. Declare useful-action deadlock freedom explicitly: Quint's TLC wrapper
disables the implicit TLC deadlock check. Neither a passing model nor an expected
counterexample proves that production code refines that model.

`--generate-traces` replaces proof checking with seeded simulation. `--output` then
names a JSON corpus file, not a report directory. It needs only the Quint-specs
opt-in, uses the TypeScript simulator, strips metadata and adjacent stutters, and
preserves model hashes. Optional `uniqueInitialStates` deduplicates initial states
and requires exactly that count. This is a coverage check, not exhaustive proof.
Malformed ITF, missing traces and wrong tool versions fail the command. Existing
output corpus is replaced only after every trace declaration succeeds.
