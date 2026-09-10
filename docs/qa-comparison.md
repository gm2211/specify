# Specify versus a general-purpose QA agent

## Status

**Authentication succeeded on 2026-09-09, but Claude subscription quota blocks the comparison. No
completed agent runs; no bug-detection comparison can be reported.**

After login, the baseline and Specify runner were both retried. The baseline reported:

```text
You've hit your limit · resets Sep 13, 2pm (America/New_York)
```

Specify received a rejected `seven_day` rate-limit event for the same reset
(`2026-09-13T18:00:00.000Z`). A minimal Sonnet availability check returned the same limit, so
switching Claude models did not provide a working fallback. Extra usage, API-key access, or the
quota reset is required; logging in again will not resolve this blocker.

The retry also reproduced SP-bzl: Specify interpreted Unix seconds as milliseconds and printed a
1970 reset date. Its error formatter now handles seconds and retains millisecond compatibility;
regression tests cover both forms. This corrects the message, not the quota itself.

See [authenticated execution record](../benchmarks/qa/quota-attempt.json) and the
[earlier login failure](../benchmarks/qa/auth-attempt.json). The raw Specify error in the
authenticated record is intentionally unchanged, including the original 1970 formatting bug. Full
local retry artifacts remain under `.specify/qa-comparison-authenticated/`.

The independent fixture checks passed: all eight expected outcomes in both builds, a scorer check
for omitted/duplicated IDs, and browser checks of healthy/defective permission behavior (four
automated tests total). These establish that the experiment can exercise its target; they do not
establish either agent's quality. No performance claim is inferred from authentication or quota
failures.

## Question

Does Specify's verification workflow improve defect detection, false-positive rate, repeatability,
or evidence quality enough to justify its extra machinery? This is a small, synthetic pilot, not
proof of superiority on real applications.

## Matched protocol

- Same `claude-opus-4-6` model, adaptive thinking, 80-turn ceiling, $2 ceiling, and four-minute
  deadline per run; 12 planned runs, at most $24 in model budget.
- Two builds of a disposable team workspace: healthy and four seeded defects. Eight reviewed
  requirements cover invitations, authorization, seat capacity, email validation, token expiration,
  and one-time acceptance.
- Three fresh runs per build per arm, alternating order between repetitions. Browser context,
  application state, working directory, and spec storage are isolated for every run. No prior memory
  or experimental features are injected.
- Both agents receive the same contract, target, setup instructions, and reset mechanism. Neither
  prompt receives defect identities or expected outcomes.
- Baseline: a short QA prompt with Playwright browser tools, structured results, and a request to
  save reusable tests. Specify: its production verify prompt and `runSpecifyAgent`, including normal
  observation recording and test-generation instructions. The harness calls the runner directly,
  excluding CLI post-run confirmation and `--cross-check` from both arms.
- Both arms share Specify's thin Playwright MCP transport and browser viewport. This controls tool
  differences: it is a **cold-start workflow ablation**, not a comparison against every possible
  vanilla agent or a separate Playwright MCP implementation. Baseline gets screenshots but not
  Specify's recorded trace or memory system. Generated output schemas are comparable, not
  byte-identical.

The fixture source and scoring oracle stay outside the agents' working directories; prompts forbid
reading outside those directories. This is a cooperative evaluation boundary, not an OS-level
source-code isolation sandbox. The test target serves the same client code for both variants;
defects live in server decisions.

## Reproduce

```bash
npm install
npx playwright install chromium
claude auth login
node --test benchmarks/qa/fixture.test.mjs
node --import tsx benchmarks/qa/run.mjs
```

Set `QA_COMPARISON_OUTPUT` to a new output directory to preserve a previous experiment. The default
is `.specify/qa-comparison/`. Each run records its result, cost when available, duration,
behavior-level scores, and an artifact directory. The parent writes `protocol.json`, `results.json`,
and child process logs. An infrastructure/model error stops the experiment and exits nonzero; failed
runs must not be scored as successful QA or treated as evidence of missed bugs.

## Scoring and interpretation

The independent oracle checks each behavior against both variants before model runs. `score.mjs`
joins results by exact behavior ID. Missing or duplicated IDs count as untested. An omitted defect
is missed; it cannot count as detected. Unknown IDs are reported separately. Defect recall uses the
four seeded defects per defective build; false positives use the healthy behaviors in each build.

Compare per-run defect recall, false positives, untested behaviors, model cost, and elapsed time.
Compare the same behavior across repetitions to assess verdict consistency. Inspect raw evidence and
generated tests before calling either usable: evidence-item counts measure presence, not truth.
Human review time is not automatically measured by this harness and needs a separate timed review.

This pilot does not measure warm-memory benefits, long-term maintenance cost, feature-impact
selection, realistic authentication, visual judgment, or large applications. The eight requirements
are intentionally small and explicit. Do not generalize a tie or a win to all QA tasks.

## Product decision

Until completed runs support a stronger claim, position Specify around behavioral contracts,
recorded observations, and reusable checks. Keep its bundled agent and background deployment
optional. A feature-impact graph remains future work, not an existing capability or a conclusion of
this experiment.
