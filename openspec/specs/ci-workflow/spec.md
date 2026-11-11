# ci-workflow Specification

## Purpose

A reusable GitHub workflow lets any repository run its formal checks in CI with one `uses:` line.

## Requirements

### Requirement: Reusable workflow

The repository SHALL provide `.github/workflows/formal.yml` as a `workflow_call` workflow that
installs Specify at the `specify-ref` input and runs `specify gate` in the `root` input directory,
with optional `tools`, `policy` and `timeout-ms` inputs. The `change` input is accepted and ignored,
because the gate checks every active change.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Minimal adoption

- **WHEN** a repository adds a job with `uses: gm2211/specify/.github/workflows/formal.yml@<tag>`
- **THEN** its linked Quint and Lean checks, policy and lock are gated on every CI run

### Requirement: Base ref and test reports

On pull requests the workflow SHALL pass the base branch to the gate as `--base`. When the
`test-reports-artifact` input names an artifact uploaded earlier in the run, the workflow SHALL
download it into the root before the gate runs.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Weakened property in a pull request

- **WHEN** a pull request edits a linked property with no change proposal
- **THEN** the gate compares against the base branch's lock and the job fails

#### Scenario: Test results from another job

- **WHEN** a test job uploads its JUnit report and the caller passes the artifact's name
- **THEN** the gate reads that report for `Verify:` lines

### Requirement: Checksum-pinned tools

The workflow SHALL install pinned versions of Quint (registry tarball, sha512), Apalache, which also
provides TLC (sha256), and Lean (release archive, sha256), and MUST fail before running checks when
a download does not match its checksum.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Tampered download

- **WHEN** a downloaded archive's checksum differs from the pinned value
- **THEN** the job fails at the install step

### Requirement: Results in the job summary

The workflow SHALL write the gate's traceability table and failures to the job log and the GitHub
job summary, and the job SHALL fail when the gate does.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Reading results on a PR

- **WHEN** a reviewer opens the formal job from a PR's checks
- **THEN** the summary shows one row per requirement

### Requirement: Lean projects

When the root has a `lakefile.lean` or `lakefile.toml`, the workflow SHALL run `lake build` and run
the checks under `lake env`.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Lake project

- **WHEN** the root has a `lakefile.toml`
- **THEN** checks run with the project's compiled dependencies available

### Requirement: Release tarballs

A push to `main` whose `package.json` version has no release yet SHALL publish a GitHub release
tagged `v<version>` with the packed `specify-<version>.tgz` and its `SHA256SUMS`, so projects can
install a pinned version globally.

- Formal: none (GitHub workflow behavior, exercised by CI itself)

#### Scenario: Version bump merged

- **WHEN** a merge to `main` sets the version to `0.8.2`
- **THEN** `releases/download/v0.8.2/specify-0.8.2.tgz` installs with `npm install --global`
