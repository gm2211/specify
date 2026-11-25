## Why

Follow-ups to the gate (specify-11): every run re-ran every check one after another, the table was
only in the job summary, and the drift lock hashed only the first paragraph of a multi-paragraph
Quint definition, so an edit further down went unnoticed.

## What Changes

- Cache passing check results and run checks concurrently (`--no-cache`, `--jobs`).
- Opt-in pull request comment in the reusable workflow, plus a cache step.
- The lock hashes the whole Quint definition. Every property that spans more than one paragraph gets
  a new hash, so `formal/specify.lock` changes for it. Specify's own `overlaySound` is one of them;
  the modified `formal-check/OpenSpec change overlay` requirement below names it so the drift lock
  treats the re-hash as covered. Its text is unchanged.
