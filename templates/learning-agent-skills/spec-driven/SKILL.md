---
name: spec-driven
description: "Verify a target (CLI, web app, API) against its behavioral contract in specify.spec.yaml. Drives the specify spec-first verification workflow."
version: 0.1.0
metadata:
  learning-rt:
    tags: [spec, verification, testing, cli, contract]
    category: software-development
    related_skills: [dogfood]
---

# Spec-Driven: Behavioral Contract Verification

## Overview

This skill drives the **specify** spec-first verification workflow. Given a `specify.spec.yaml` file describing a target's behavioral contract, you will run each declared behavior against the live target, gather evidence, and produce a structured verification report.

A spec is a tree of `areas`, each containing `behaviors`. Every behavior is a single observable claim that can be checked against the running target.

## Inputs

The user (or invoking workflow) provides:

1. **Spec path** — path to a `specify.spec.yaml` file (default: `./specify.spec.yaml` in the working tree).
2. **Target** — declared by `target:` in the spec. Currently supported: `cli`, `web`, `http`.
3. **Scope** (optional) — area IDs or behavior IDs to verify. Default: all behaviors.
4. **Output dir** (optional) — directory for evidence artifacts. Default: `./.specify-runs/<timestamp>/`.

## Prerequisites

- `spec_load` tool — parses spec YAML into a structured plan.
- `spec_run_behavior` tool — executes a single behavior against the target and records evidence.
- `spec_report` tool — aggregates per-behavior results into a summary report.
- For CLI targets: shell access to invoke the binary.
- For web targets: browser toolset (`browser_navigate`, `browser_snapshot`, `browser_click`, ...).
- For HTTP targets: `http_request` tool (or equivalent).

## Workflow

Follow these phases. Do not skip phases — the audit trail depends on each phase emitting structured output the next phase consumes.

### Phase 1: Plan

1. Call `spec_load` with the spec path. The tool returns a normalized plan: list of `(area_id, behavior_id, description, target_kind)` tuples.
2. Apply scope filter if provided. Otherwise verify every behavior.
3. Initialize the output directory.
4. Write `plan.json` listing every behavior that will be checked.

### Phase 2: Verify

For each behavior in the plan:

1. Read `description`. The description is a natural-language claim — your job is to translate it into a concrete check against the target.
2. Choose the right tool family based on `target.type`:
   - `cli` → invoke the binary via shell, capture stdout/stderr/exit-code.
   - `web` → use the browser toolset to drive UI flows.
   - `http` → make HTTP requests and assert responses.
3. Run `spec_run_behavior` with the behavior id + observed evidence (command, output, or trace). The tool records pass/fail and writes evidence to the output dir.
4. On failure, capture enough context that a human can reproduce: exact command, full output, environment, timestamp.

Do not stop on first failure — continue through every behavior. The report needs the full picture.

### Phase 3: Report

1. Call `spec_report` with the output directory. It aggregates `behavior_*.json` files into `report.md` and `report.json`.
2. Surface the summary to the user: total behaviors, passed, failed, skipped. Link the report path.
3. If failures occurred, list the failing behavior IDs with one-line cause each.

## Failure modes to watch

- **Spec drift** — a behavior in the spec no longer matches what the target does. Report it; do not silently update the spec.
- **Ambiguous descriptions** — descriptions that admit multiple interpretations. Pick the most conservative reading (the strictest check) and note the ambiguity in evidence.
- **Missing target** — `target.binary` does not exist, web target is down, HTTP endpoint unreachable. Fail fast with a clear setup error before iterating.
- **Side effects** — a behavior may mutate target state. Run idempotent checks first; group destructive ones at the end of the plan.

## Learning hooks

This skill is meant to improve over time. After each verification run:

- If you discovered a verification pattern that worked well (e.g. "for `--help` checks, grep for the program name in the first line"), record it via the memory tool with a stable, queryable key.
- If a behavior description was hard to parse, propose a clearer wording in the report. Do **not** edit the spec yourself — the user owns spec text.
- If the same false-failure recurs, surface it as a candidate for a sub-skill ("known-flaky-checks").

## Output contract

Every run produces:

- `plan.json` — what was attempted.
- `behavior_<area>_<id>.json` — one per behavior, with `status`, `evidence`, `command`, `output`, `duration_ms`.
- `report.md` + `report.json` — aggregated summary.

Downstream consumers (the specify webapp, CI gates) parse `report.json` — keep the schema stable.
