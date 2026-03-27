# Agent Guide: Setting Up GitHub QA Gating with Specify

This document is written for an AI agent. When a user says "set up GitHub gating with Specify", "add Specify to CI", or similar, follow these instructions exactly.

---

## Prerequisites

Before copying the workflow, verify that both of the following are in place:

### 1. A Specify spec file

The spec file (`spec.yaml` or `*.spec.yaml`) is a YAML contract that describes what the app should do. Specify uses it to drive agent-based verification.

**Check for an existing spec:**
```bash
ls spec.yaml *.spec.yaml 2>/dev/null || find . -name '*.spec.yaml' -maxdepth 3
```

If no spec file exists, generate one using one of these commands (run against a live or local instance of the app):

```bash
# Option A — agent captures behavior automatically from a running app
specify capture --url http://localhost:3000

# Option B — guided interview to write the spec from scratch
specify create
```

After generation, lint the spec to confirm it is valid:
```bash
specify lint --spec spec.yaml
```

### 2. An `ANTHROPIC_API_KEY` GitHub secret

The workflow requires this secret to power the verification agent.

**Tell the user:** Go to **Settings → Secrets and variables → Actions → New repository secret** and add `ANTHROPIC_API_KEY` with their Anthropic API key value.

You cannot add GitHub secrets programmatically (they require browser interaction). Document this requirement clearly in your response.

---

## Step-by-Step Instructions

### Step 1 — Copy the workflow template

```bash
mkdir -p .github/workflows
cp <path-to-specify-templates>/github-action/specify-qa.yml .github/workflows/specify-qa.yml
```

If the Specify templates directory is not available locally, write the workflow file from the canonical template (see `templates/github-action/specify-qa.yml` in the Specify repository).

### Step 2 — Set `SPEC_FILE`

At the top of `.github/workflows/specify-qa.yml`, set `SPEC_FILE` to the path of the spec file relative to the repo root:

```yaml
env:
  SPEC_FILE: spec.yaml          # or e.g. apps/web/spec.yaml
```

### Step 3 — Set `HEALTH_CHECK_URL`

Set `HEALTH_CHECK_URL` to the URL your app listens on in CI. This is both the liveness probe URL (polled until the app is ready) and the target URL passed to `specify verify`.

```yaml
  HEALTH_CHECK_URL: http://localhost:3000   # adjust port/path to match your app
```

If your app has a dedicated health endpoint (e.g. `/health`, `/api/status`), use that URL for the poll but pass the app root to `specify verify --url`. In that case, add a separate `VERIFY_URL` variable and update the `docker run` command accordingly.

### Step 4 — Fill in the "Start app" step

Replace the placeholder in the `Start app` step with the actual command to launch the user's app. See the **Common Patterns** section below for copy-paste examples.

The command must:
- Install dependencies if needed
- Build the app if needed
- Start the server **in the background** (so the step exits and subsequent steps run)
- Have the app listen on the port matching `HEALTH_CHECK_URL`

### Step 5 — Commit and push

```bash
git add .github/workflows/specify-qa.yml
git commit -m "Add Specify QA gate"
git push
```

Verify the workflow appears under **Actions** in the GitHub UI and passes on the next push or PR.

---

## Common Patterns

### docker-compose

```yaml
- name: Start app
  run: docker compose up -d
```

Adjust `HEALTH_CHECK_URL` to match the port exposed by your compose service (check `docker-compose.yml`).

### Next.js

```yaml
- name: Start app
  run: |
    npm ci
    npm run build
    npm start &
```

Default port is 3000. Set `HEALTH_CHECK_URL: http://localhost:3000`.

### Express / generic Node server

```yaml
- name: Start app
  run: |
    npm ci
    node server.js &
```

### Rails

```yaml
- name: Start app
  run: |
    bundle install
    RAILS_ENV=test bundle exec rails db:setup
    bundle exec rails server --daemon
```

Set `HEALTH_CHECK_URL: http://localhost:3000`.

### FastAPI (uvicorn)

```yaml
- name: Start app
  run: |
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000 &
```

Set `HEALTH_CHECK_URL: http://localhost:8000`.

### Flask (gunicorn)

```yaml
- name: Start app
  run: |
    pip install -r requirements.txt
    gunicorn app:app --bind 0.0.0.0:5000 --daemon
```

Set `HEALTH_CHECK_URL: http://localhost:5000`.

---

## How the Verify Step Works

```
docker run --rm \
  --network host \                                          # reach localhost app
  -e ANTHROPIC_API_KEY="..." \                             # from GitHub secret
  -v "$WORKSPACE/spec.yaml:/spec/spec.yaml:ro" \          # spec read-only
  -v "$WORKSPACE/.specify:/workspace/.specify" \           # output written back
  ghcr.io/gm2211/specify:latest \
  verify --spec /spec/spec.yaml --url http://localhost:3000 --output /workspace/.specify/verify
```

Exit codes:
- `0` — all behaviors passed
- `1` — one or more behaviors failed (workflow step fails, PR is blocked)
- `10` — argument/file error (missing spec, bad URL)
- `12` — timeout
- `14` — browser error (Chromium crash)

Artifacts uploaded on failure include `verify-result.json` (structured breakdown) and screenshots.

---

## Troubleshooting

### "App did not become healthy" — health check times out

- Check that the start command actually launches the server before the step exits. For background processes (`&`), add a small explicit sleep or rely on the polling loop.
- Confirm the port in `HEALTH_CHECK_URL` matches what the app binds to.
- Increase `HEALTH_CHECK_TIMEOUT` if the build step is slow.

### "ANTHROPIC_API_KEY not set" or 401 errors from Specify

- Confirm the secret name is exactly `ANTHROPIC_API_KEY` (case-sensitive) in GitHub repository settings.
- Make sure it is a repository secret, not an environment secret scoped to a different environment.

### Spec file not found inside the container

- Verify `SPEC_FILE` is a path relative to the repo root and the file is committed to git.
- The bind-mount maps `${{ github.workspace }}/${{ env.SPEC_FILE }}` on the host to `/spec/spec.yaml` inside the container. If the spec is nested (e.g. `apps/web/spec.yaml`), set `SPEC_FILE: apps/web/spec.yaml`.

### Chromium / browser errors (exit code 14)

- The Specify Docker image bundles Chromium. No additional setup is needed.
- If running on a self-hosted runner with a restrictive seccomp profile, add `--security-opt seccomp=unconfined` to the `docker run` command.

### Verify passes locally but fails in CI

- The verification agent sees the app exactly as an external HTTP client would. Check for:
  - Environment-specific feature flags or auth middleware that block unauthenticated access.
  - Hardcoded `localhost` references that break inside Docker (`--network host` is used, so `localhost` should resolve correctly on Linux runners).
  - Data seeding: the agent may expect data that only exists after a seed step.
- Review the uploaded `verify-result.json` artifact for per-behavior failure details.

### Workflow file not showing in GitHub Actions tab

- The file must live under `.github/workflows/` with a `.yml` or `.yaml` extension and be on the default branch (or the branch targeted by the PR). Confirm with `git status`.
