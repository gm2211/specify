# Spec Kit extension

`behavior-contracts` is an optional GitHub Spec Kit extension with three namespaced agent commands:

- `speckit.behavior-contracts.capture` records an accepted decision in the repository's canonical
  Specify spec.
- `speckit.behavior-contracts.review` reviews planned work against that spec.
- `speckit.behavior-contracts.reconcile` compares implementation and execution evidence with its
  behaviors.

Each command reads the project's `AGENTS.md`, resolves its canonical spec, invokes Specify's
`spec guide` workflow, and follows the corresponding `workflow.capture`, `workflow.review`, or
`workflow.reconcile` instructions. The commands report results in the existing PR or task record.
They do not add hooks, run implementation code from user input, generate a competing `spec.md`, copy
requirements into Spec Kit plans, or create another evidence store.

## Install

Initialize Spec Kit in the target project first. Run Specify's `spec init` with its absolute CLI
path to install the canonical spec guidance in `AGENTS.md`. That guidance records the spec path and
the command root used to resolve it. Then add only the explicit absolute path to the Specify CLI in
`AGENTS.md`, outside its managed block. Do not add a second canonical-spec entry. For example:

```text
Specify CLI: /Users/alex/src/specify/specify
```

Initialize the guidance from the repository root, using its real paths:

```bash
"/Users/alex/src/specify/specify" spec init --spec product.spec
```

Use the actual paths for that checkout and repository. This matters because both products expose an
executable named `specify`: the extension commands require the Specify path from `AGENTS.md` or an
explicit user instruction and never guess from `PATH`.

Then install the local extension with GitHub Spec Kit's own CLI:

```bash
uvx --from git+https://github.com/github/spec-kit.git@ae5ade7234be5cb1d975f736c4e06dd46d1326d6 \
  specify extension add --dev /absolute/path/to/specify/integrations/spec-kit/behavior-contracts
```

The pinned source above reports Spec Kit CLI version `1.1.1.dev0`; this is the version used to
validate the extension manifest and local install. In an already managed Spec Kit environment, use
its own `specify extension add --dev ...` command instead. Spec Kit requires an initialized project
before extension installation; see its
[extension reference](https://github.com/github/spec-kit/blob/ae5ade7234be5cb1d975f736c4e06dd46d1326d6/docs/reference/extensions.md)
and
[extension manifest API](https://github.com/github/spec-kit/blob/ae5ade7234be5cb1d975f736c4e06dd46d1326d6/extensions/EXTENSION-API-REFERENCE.md).

Invoke the registered capture, review, and reconcile commands using the spelling shown by your
coding-agent integration. Spec Kit renders command names differently across integrations; its
[integration reference](https://github.com/github/spec-kit/blob/ae5ade7234be5cb1d975f736c4e06dd46d1326d6/docs/reference/integrations.md)
describes the forms.

## Scope and compatibility

Installation was exercised in a disposable project using Spec Kit's `generic` integration at the
pinned revision above: all three extension commands registered, and core `speckit.specify` stayed
unchanged. Other agent-specific renderings were not exercised in this acceptance run.

This extension is a parallel optional workflow, not a drop-in replacement for Spec Kit's core
specification-driven-development flow. Core Spec Kit commands remain installed and available. Use
the core flow when its generated `spec.md`, plan, task list, and implementation phases are desired;
use these commands when the project keeps its contract in Specify and wants capture, review, and
reconciliation to follow that contract directly. Do not run core spec generation as part of these
commands or copy the same requirements into a second authority.

The extension manifest requires Spec Kit `>=1.1.1.dev0`. It provides only
`speckit.behavior-contracts.*` commands and declares no core-command overrides, hooks, templates, or
scripts. The extension itself does not execute shell snippets embedded in user requests. Agents use
the explicit Specify executable path for the guide and any protocol-directed validation, and use the
project's existing runners for application tests and other execution evidence.
