# README media

These screenshots and the terminal demo show the bundled Specify reader and supported CLI workflow.
Screenshots use Specify's own canonical spec, with the same behavior selected in both themes. They
are real browser captures, not mockups.

## Terminal walkthrough

The GIF records these commands against a disposable copy of `specify.spec`:

```bash
sed -n 8,15p specify.spec/areas/overview.yaml
specify spec init --spec specify.spec
specify spec lint --spec specify.spec
specify view --no-open
```

1. Read a stable behavior ID, human title, rationale, and precise contract.
2. Install managed capture/review/reconcile instructions in the demo project's `AGENTS.md`.
3. Validate the spec's structure. This does not execute application tests.
4. Start the bundled local reader. Open the printed URL in your browser; stop with Ctrl-C.

The recording script invokes the checkout's built CLI as `specify`, then stops its viewer and
removes the disposable project. It does not alter the checkout's agent instructions or publish a
recording to an external service. Commands are presented with reading pauses; their output is
captured live.

## Re-record

Install asciinema 3 and agg (on macOS: `brew install asciinema agg`), then run from the repository:

```bash
npm ci
bash scripts/record-demo.sh
asciinema play docs/media/demo.cast
```

The script builds Specify, records a 96 × 28 terminal, and renders a looping GIF with Menlo at 16 px
and a dark palette. Use a locally available monospace font in the agg command if Menlo is absent.
The original cast remains available for pausing, replaying, and selecting terminal text.

## Refresh screenshots

Run `./specify view --no-open --port 4310`, open the printed URL, and select
`overview/no-args-returns-json-manifest`. Capture the reader in Light and Dark themes as
`reader-light.jpg` and `reader-dark.jpg`. Keep the purpose, rationale, and exact contract visible;
capture the actual UI without annotations or generated replacements. The README chooses the matching
image for the reader's color scheme and provides direct links to both.
