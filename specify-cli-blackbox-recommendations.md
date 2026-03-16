Specify CLI black-box evaluation

Scope

This evaluation was done by interacting only with `./specify`. No repo docs or source files were used.

Conclusion

It is not easy enough to infer the workflow for "add a new feature to an existing service" from the binary alone.

What was understandable

- `./specify --help` makes the main concepts visible: `create`, `capture`, `evolve`, `verify`, `review`.
- `./specify human` is the clearest entry point. It detects an existing spec and offers `Evolve`.
- `./specify evolve` auto-discovers an existing spec and can propose changes.
- Some error handling is good. For example, `./specify capture` reports a clear missing-parameter hint for `--url`.

What was not clear enough

- There is no first-class workflow labeled for the real task: adding a feature to an existing service.
- `create` reads as greenfield.
- `capture` reads as behavior recording, not feature authoring.
- `evolve` sounds promising, but the interactive path led quickly into spec-maintenance prompts such as default properties, assumptions, and pages, instead of starting from the user's intent.
- `./specify <subcommand> --help` did not show subcommand-specific help. It fell back to the top-level help text, which makes discovery materially worse.

Recommended changes

1. Add a first-class maintenance workflow

Introduce a command or guided mode explicitly named for this use case, for example:

- `specify feature add`
- `specify human` -> `Add a feature to an existing service`

This should be the obvious path for an agent or user who already has a service and wants to extend it.

2. Make the guided flow task-oriented

The interactive sequence should start from user intent, not spec structure. A good flow would be:

1. Select the existing spec
2. Choose input source: live URL, PR diff, or existing test/code
3. Ask: "What feature are you adding?"
4. Ask for feature entry points or affected routes/commands
5. Capture or analyze only the relevant surface area
6. Show a proposed spec diff
7. Apply and optionally verify

This is much easier to understand than starting with prompts like "Add default properties?" or "Add pages?"

3. Fix subcommand help

`specify <subcommand> --help` should always show command-specific help, examples, modes, and decision guidance.

For this product, that is not a polish issue. It is core discoverability.

4. Add decision guidance in help output

Top-level help should explain when to use each command in plain workflow terms. For example:

- `create`: start a new spec from scratch
- `capture`: derive baseline behavior from a running service or tests
- `evolve`: update an existing spec for a feature change, PR, or validation gap
- `verify`: check an implementation against a spec

Even better, add a short "Common tasks" section with examples.

5. Add examples for the maintenance case

The help output should include examples that match the actual agent use case, such as:

- `specify evolve --spec spec.yaml --url http://localhost:3000`
- `specify evolve --spec spec.yaml --pr 42`
- `specify feature add --spec spec.yaml --describe "Add saved searches"`

Without examples like these, the intended workflow has to be guessed.

6. Improve interactive wording in `human` and `evolve`

Use prompts that make the mental model obvious:

- "Are you creating a new spec or changing an existing one?"
- "What feature or behavior changed?"
- "How should I learn about it: live app, PR, or tests?"
- "Do you want me to propose a spec patch?"

This language matches what a user or agent is actually trying to do.

7. Separate spec hygiene from feature evolution

If `evolve --apply` finds missing defaults, assumptions, or other hygiene improvements, present them after the feature-change flow or in a separate optional section.

Those suggestions are useful, but they currently distract from the primary task.

Summary

The CLI is understandable enough for general verification and partial spec maintenance, but the specific workflow for adding a feature to an existing service is not yet self-explanatory from the binary alone.

The highest-value changes are:

- a first-class "add feature to existing service" path
- real subcommand help
- task-oriented prompts
- examples that match the maintenance workflow
