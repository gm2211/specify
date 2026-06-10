# --- Build stage ---
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Root deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Webapp deps
COPY webapp/package.json webapp/package-lock.json* webapp/
RUN cd webapp && npm ci --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY webapp/ webapp/
COPY assets/ assets/

# Build TS + webapp bundle (vite output → dist/webapp/, served by review server)
RUN npx tsc --project tsconfig.json \
 && cd webapp && npx vite build

# --- Runtime stage ---
FROM node:22-bookworm-slim

# Playwright system deps (Chromium only) + native-module build tools
# (python3 / make / g++ are needed as a fallback if better-sqlite3's
# prebuild-install cannot find a prebuilt .node for this exact Node ABI —
# they let node-gyp compile from source instead of aborting).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    libx11-xcb1 fonts-liberation fonts-noto-color-emoji \
    ca-certificates tini \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps + Playwright Chromium
# PLAYWRIGHT_BROWSERS_PATH is pinned to /app/.ms-playwright so the browser
# binaries land at a fixed location inside the image layer, independent of
# HOME.  Without this, `npx playwright install` writes to $HOME/.cache/…
# (= /root/.cache/… at build time) but at runtime HOME is redirected to /work
# (the PVC mount), causing browserType.launch to fail with "Executable doesn't
# exist" because /work/.cache/ms-playwright is empty.
#
# better-sqlite3 native binding: npm ci uses --ignore-scripts so the postinstall
# download/build is skipped.  We then run `npm rebuild better-sqlite3` which
# invokes prebuild-install (prebuilt .node from GitHub releases for this exact
# Node ABI) and falls back to node-gyp compile-from-source if no prebuilt
# matches.  This ensures the .node binary is present and linked to the correct
# libc/arch before the image is sealed.  Without this the session indexer and
# confidence store both warn "unavailable" on every run.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild better-sqlite3 \
 && PLAYWRIGHT_BROWSERS_PATH=/app/.ms-playwright npx playwright install chromium \
 && rm -rf /tmp/*

# Built artefacts
COPY --from=build /app/dist/ dist/
COPY assets/ assets/

# Non-root user for security (required by claude CLI: --dangerously-skip-permissions
# refuses to run as root/uid=0; running as a non-root user avoids the IS_SANDBOX=1
# workaround that was needed to bypass the root-detection check).
RUN groupadd --gid 1001 specify \
 && useradd --uid 1001 --gid 1001 --no-create-home specify \
 && chown -R specify:specify /app /app/.ms-playwright

# State dir for memory rows, sessions.db, skills, reports.
# Mount a PVC here in k8s so learning persists across pod restarts.
RUN mkdir -p /work && chown specify:specify /work
WORKDIR /work
# HOME=/work so the auto-generated daemon token lands on the PVC,
# along with spec-relative state dirs (.specify/memory, .specify/sessions.db, …).
# PLAYWRIGHT_BROWSERS_PATH is kept consistent with the install step above so
# Playwright resolves the Chromium binary at /app/.ms-playwright/chromium-*/
# regardless of where HOME points.
ENV NODE_ENV=production \
    HOME=/work \
    PLAYWRIGHT_BROWSERS_PATH=/app/.ms-playwright \
    PORT=4100 \
    HOST=0.0.0.0

USER specify

EXPOSE 4100

LABEL org.opencontainers.image.source="https://github.com/gm2211/specify" \
      org.opencontainers.image.description="Specify QA agent — runs as a long-lived daemon, verifies a target app against its spec, learns over time" \
      org.opencontainers.image.licenses="MIT"

# tini as PID 1 so SIGTERM forwards cleanly during pod terminations
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/src/cli/index.js"]
CMD ["daemon", "--host", "0.0.0.0", "--port", "4100"]
