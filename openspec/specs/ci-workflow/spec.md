# ci-workflow Specification

## Purpose

A reusable GitHub workflow lets any repository run its formal checks in CI with one `uses:` line.

## Requirements

### Requirement: Reusable workflow

The repository SHALL provide `.github/workflows/formal.yml` as a `workflow_call` workflow that
installs Specify from `gm2211/specify` at the `specify-ref` input and runs `specify formal check` in
the `root` input directory, with optional `tools`, `change` and `timeout-ms` inputs.

#### Scenario: Minimal adoption

- **WHEN** a repository adds a job with `uses: gm2211/specify/.github/workflows/formal.yml@<tag>`
- **THEN** its linked Quint and Lean checks run on every CI run

### Requirement: Checksum-pinned tools

The workflow SHALL install pinned versions of Quint (registry tarball, sha512), Apalache, which also
provides TLC (sha256), and Lean (release archive, sha256), and MUST fail before running checks when
a download does not match its checksum.

#### Scenario: Tampered download

- **WHEN** a downloaded archive's checksum differs from the pinned value
- **THEN** the job fails at the install step

### Requirement: Results in the job summary

The workflow SHALL write the requirement → result table to the job log and the GitHub job summary,
and the job SHALL fail when `formal check` does.

#### Scenario: Reading results on a PR

- **WHEN** a reviewer opens the formal job from a PR's checks
- **THEN** the summary shows one row per requirement and check

### Requirement: Lean projects

When the root has a `lakefile.lean` or `lakefile.toml`, the workflow SHALL run `lake build` and run
the checks under `lake env`.

#### Scenario: Lake project

- **WHEN** the root has a `lakefile.toml`
- **THEN** checks run with the project's compiled dependencies available

### Requirement: Release tarballs

A push to `main` whose `package.json` version has no release yet SHALL publish a GitHub release
tagged `v<version>` with the packed `specify-<version>.tgz` and its `SHA256SUMS`, so projects can
install a pinned version globally.

#### Scenario: Version bump merged

- **WHEN** a merge to `main` sets the version to `0.8.2`
- **THEN** `releases/download/v0.8.2/specify-0.8.2.tgz` installs with `npm install --global`
