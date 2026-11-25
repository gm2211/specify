## MODIFIED Requirements

### Requirement: OpenSpec change overlay

With `--change <name>`, the checker SHALL also read `openspec/changes/<name>/specs/**/spec.md`:
requirements the change adds or modifies replace the main spec's links for the same requirement, and
requirements under `## REMOVED Requirements` are dropped from the report.

- Formal: quint formal/Overlay.qnt overlaySound main=Overlay
- Formal: quint formal/Overlay.qnt overlaySound main=OverlayBefore expect=fails
- Verify: test formal-check/OpenSpec change overlay

#### Scenario: Modified requirement

- **WHEN** a change modifies a requirement and gives it a new `Formal:` link
- **THEN** only the change's link runs for that requirement

#### Scenario: Unsafe change name

- **WHEN** the change name contains a path separator
- **THEN** the command is rejected
