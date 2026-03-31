# --- Build stage ---
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install root dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Install webapp dependencies
COPY webapp/package.json webapp/package-lock.json* webapp/
RUN cd webapp && npm ci --ignore-scripts 2>/dev/null || true

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY webapp/ webapp/
COPY assets/ assets/
RUN npx tsc --project tsconfig.json

# --- Runtime stage ---
FROM node:22-bookworm-slim

# Playwright system dependencies (Chromium only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
    libx11-xcb1 fonts-liberation fonts-noto-color-emoji \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps + Playwright browsers
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npx playwright install chromium \
    && rm -rf /tmp/* /root/.cache/ms-playwright/.links

# Webapp deps
COPY webapp/package.json webapp/package-lock.json* webapp/
RUN cd webapp && npm ci --omit=dev 2>/dev/null || true

# Copy built output and assets
COPY --from=build /app/dist/ dist/
COPY webapp/ webapp/
COPY assets/ assets/

# Entry point
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/src/cli/index.js"]
