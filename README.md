# Specify

**Web capture toolkit for spec-based functional verification**

<!-- badges placeholder -->

---

## What is Specify?

Specify is a toolkit for capturing how a web application behaves and turning that behavior into a verifiable functional spec. Instead of writing tests that describe implementation details, you observe what users actually experience — the pages they see, the network requests the app makes, the console output — and encode that into a computational spec.

The spec describes functional requirements: what should be visible on a given page, what network calls should happen during a user flow, what error conditions the app should handle gracefully. This is not an API documentation tool. The spec captures the user-facing behavior of the system, including visual state.

When you run a target site against the spec, Specify produces a gap analysis report. The report tells you which requirements are met, which are missing, and which were not tested. If you're building a replacement, a migration, or a fork of an existing application, the gap analysis tells you exactly where you stand.

---

## How It Works

```
Reference Site ──► Capture ──► Spec (computational, functional)
                                        │
                                        ▼
Your Site ──────► Capture ──► Gap Analysis Report
                                (met / not met / untested)
```

**Step 1 — Capture:** Browse a reference website using Specify's capture tools. You can do this manually (you drive the browser) or with an autonomous agent. The tools record network traffic, screenshots, and console logs as you navigate.

**Step 2 — Spec:** Feed the captured data to an LLM or analysis pipeline to generate a computational spec — a structured description of pages, expected network calls, visual assertions, user flows, and interaction scenarios.

**Step 3 — Validate:** Browse your own site with the same capture tools. Compare the output against the spec. Get a gap analysis report showing what requirements are met and what's missing.

**Step 4 — Automate:** An autonomous agent accepts a spec and a target URL, plans a browsing strategy, runs headless Playwright, captures everything, and produces the gap report — no human required.

Human-driven and agent-driven capture produce the same output format. The spec and the gap report are identical regardless of who did the clicking.

---

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Configure your target
cp .env.example .env
# Edit .env — set TARGET_BASE_URL at minimum

# Save a session (if your app requires auth)
npm run login

# Start capturing
npm run browse
```

Capture output lands in `captures/<timestamp>/`. Hand the folder to an LLM for analysis.

---

## Capture Tools

### `npm run login` — Save a session

Opens a browser, navigates to your login page, and waits for you to log in manually. Press Enter when you're on the post-login page and it will save cookies and Playwright storage state to `.auth/`.

```bash
TARGET_BASE_URL=https://app.example.com npm run login
```

Output:
- `.auth/cookies.json` — raw cookies
- `.auth/storage-state.json` — Playwright storage state (reused by other tools)

---

### `npm run browse` — Interactive capture (recommended starting point)

The primary capture tool. Opens a visible browser, loads your target URL, and records everything as you browse:

- All network traffic (requests + JSON response bodies)
- Screenshots on every page navigation and after significant API responses
- All browser console logs
- JavaScript bundle URLs

Press `Ctrl+C` when done. Everything saves automatically to a timestamped directory.

```bash
TARGET_BASE_URL=https://app.example.com npm run browse

# Custom output directory
node scripts/browse-and-capture.mjs --output ./my-captures
```

Output in `captures/<timestamp>/`:
```
traffic.json      — API requests with response bodies
console.json      — browser console log entries
screenshots/      — PNG screenshots (auto-named by page)
summary.txt       — endpoint summary table
js-sources.json   — JavaScript URLs found on visited pages
```

> This is the recommended tool for most workflows. It works with any website — no special configuration needed beyond `TARGET_BASE_URL`.

---

### `npm run capture` — CDP passive capture

Connects to an already-running Chrome instance via Chrome DevTools Protocol and passively records traffic. Useful when you want to use your normal browser profile or have an existing Chrome session.

```bash
# First, launch Chrome with remote debugging enabled:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug

# Then start capturing:
npm run capture
```

Configuration:
```bash
CDP_HOST=localhost   # Chrome DevTools host (default: localhost)
CDP_PORT=9222        # Chrome DevTools port (default: 9222)
```

Output in `captures/`:
- `traffic-<timestamp>.json` — full capture with response bodies
- `traffic-<timestamp>-summary.txt` — endpoint summary table

---

### `npm run discover` — Autonomous API discovery

Loads your stored session, visits configured pages with a headless browser, mines JavaScript bundles for API patterns, and probes discovered endpoints. Produces a structured discovery report.

```bash
# Configure pages to visit in .env:
DISCOVER_PAGES=/dashboard,/settings,/profile

npm run discover
```

Output in `docs/`:
- `api-discovery.md` — human-readable discovery report
- `api-discovery-raw.json` — raw data for programmatic analysis

Safety: only GET/HEAD/OPTIONS requests, with rate limiting between requests.

---

### `npm run live-discover` — Live traffic intercept

Similar to `discover` but records actual live traffic as each page loads, rather than probing endpoints separately. Also generates TypeScript interface shapes from observed response bodies.

```bash
LIVE_DISCOVER_PAGES=/dashboard,/settings,/profile npm run live-discover
```

Output in `docs/`:
- `live-discovery.md` — full report with confirmed traffic
- `live-discovery-raw.json` — raw request/response exchanges

---

### `npm run live-discover-fetch` — Browser-free alternative

Uses Node.js native `fetch` instead of a browser. Lighter weight than the Playwright-based tools, but may be blocked by sites with aggressive bot protection (Cloudflare, etc.).

```bash
npm run live-discover-fetch
```

Output in `docs/`:
- `live-discovery-fetch.md` — discovery report
- `live-discovery-fetch-raw.json` — raw results

---

## Spec Format

A Specify spec is a structured JSON (or JSON5) document that describes the functional behavior of a web application. It is generated from capture output — not written by hand — and is designed to be read by both humans and validation tools.

### Top-level structure

```json
{
  "version": "1",
  "metadata": {
    "name": "My App",
    "baseUrl": "https://app.example.com",
    "generatedAt": "2024-01-15T10:00:00Z"
  },
  "pages": [...],
  "scenarios": [...],
  "flows": [...],
  "variables": {...},
  "hooks": {...}
}
```

### Pages

Each page describes the functional state a user should see at a given URL:

```json
{
  "id": "dashboard",
  "path": "/dashboard",
  "visualAssertions": [
    { "type": "visible", "description": "Navigation sidebar" },
    { "type": "visible", "description": "Summary statistics widget" },
    { "type": "not-visible", "description": "Error banner" }
  ],
  "expectedRequests": [
    {
      "method": "GET",
      "pathPattern": "/api/v1/stats",
      "status": 200,
      "required": true
    },
    {
      "method": "GET",
      "pathPattern": "/api/v1/user/me",
      "status": 200,
      "required": true
    }
  ],
  "consoleExpectations": [
    { "type": "no-errors" }
  ]
}
```

### Scenarios

A scenario is a named interaction sequence:

```json
{
  "id": "user-creates-item",
  "description": "User creates a new item from the dashboard",
  "steps": [
    { "action": "navigate", "path": "/dashboard" },
    { "action": "click", "target": "Create button" },
    { "action": "fill", "target": "Name field", "value": "{{variables.itemName}}" },
    { "action": "click", "target": "Save button" },
    { "action": "assert", "expectation": "Success confirmation visible" }
  ],
  "expectedRequests": [
    { "method": "POST", "pathPattern": "/api/v1/items", "status": 201 }
  ]
}
```

### Variables and hooks

Variables allow specs to be parameterized. Hooks define setup and teardown actions:

```json
{
  "variables": {
    "itemName": "Test Item",
    "userId": "user-123"
  },
  "hooks": {
    "beforeAll": ["authenticate"],
    "afterEach": ["reset-state"]
  }
}
```

> **Note:** The spec format is defined but tooling to generate specs automatically from captures and to run validation against a spec is under active development (see Roadmap).

---

## Validation & Gap Analysis

Once you have a spec and captures from your target site, validation compares the two and produces a gap analysis report.

### Gap analysis report structure

```json
{
  "summary": {
    "met": 12,
    "notMet": 3,
    "untested": 5
  },
  "pages": [
    {
      "pageId": "dashboard",
      "status": "partial",
      "visualAssertions": [
        { "assertion": "Navigation sidebar", "result": "met" },
        { "assertion": "Summary statistics widget", "result": "not-met" }
      ],
      "expectedRequests": [
        { "pattern": "/api/v1/stats", "result": "met" },
        { "pattern": "/api/v1/user/me", "result": "met" }
      ]
    }
  ]
}
```

Each requirement in the spec gets one of three outcomes:
- **met** — the target site satisfied this requirement
- **not-met** — the requirement was tested and failed
- **untested** — the validator didn't reach this part of the spec

> **Status:** Automated spec generation from captures and gap analysis execution are on the roadmap. The capture tools and spec format are production-ready. Use captures + an LLM today for manual analysis.

---

## Mock Server

The mock server replays captured traffic as a real HTTP server. Point your application at it during development or testing to work against known, controlled responses.

```bash
# Start with real captured responses
npm run mock

# Start with 10% fault injection
npm run mock:chaos

# Point at a specific capture file
MOCK_DATA_PATH=captures/2024-01-15_10-30-00/traffic.json npm run mock
```

The server starts on port 3456 by default.

### Session management

The mock server issues real session cookies and manages sessions with a configurable TTL. It handles login redirects and supports a cookie refresh endpoint:

```bash
MOCK_SESSION_COOKIE_NAME=session   # Cookie name to issue
MOCK_SESSION_TTL_MS=600000         # Session TTL (default: 10 minutes)
MOCK_LOGIN_PATH=/login             # Login page path
MOCK_POST_LOGIN_REDIRECT=/         # Where to redirect after login
```

### Fault injection

```bash
MOCK_FAULT_RATE=0.1                           # 10% of requests get a fault
MOCK_FAULT_TYPES=302,500,timeout,empty,malformed  # Which fault types to use
```

Available fault types:
- `302` — unexpected redirect
- `500` — internal server error
- `timeout` — connection hangs
- `empty` — empty response body
- `malformed` — malformed JSON

### Diagnostic endpoints

While the mock server is running, these endpoints are available without auth:

```
GET /          → route index (all captured endpoints)
GET /_traffic  → raw traffic data
GET /_faults   → fault injection state
GET /_sessions → active sessions
```

---

## Agent-Driven Validation (Roadmap)

The long-term goal is fully autonomous spec verification:

1. **Input:** A spec file + a target URL
2. **Planning:** An agent reads the spec and plans a click-around strategy to cover all pages and scenarios
3. **Execution:** The agent drives headless Playwright, captures traffic and screenshots at each step
4. **Report:** Produces the gap analysis report without any human involvement

The capture tools are already built with agent use in mind — they accept environment variables for configuration, produce machine-readable JSON output, and work headlessly. Human and agent capture produce identical output.

Planned agent capabilities:
- Automatic login and session management
- Scenario replay from spec flows
- Coverage tracking (which spec requirements were exercised)
- Retry on transient failures

---

## Configuration

Copy `.env.example` to `.env` and set your values. All variables are optional unless marked required.

```bash
cp .env.example .env
```

### Key variables

| Variable | Default | Description |
|---|---|---|
| `TARGET_BASE_URL` | — | **Required.** Base URL of the app under test |
| `TARGET_LOGIN_URL` | `TARGET_BASE_URL` | Login page URL |
| `CAPTURE_HOST_FILTER` | derived from URL | Hostname substring to filter traffic |
| `CAPTURE_OUTPUT_DIR` | `captures/` | Output directory for captures |
| `AUTH_DIR` | `.auth/` | Directory for saved session state |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `STORAGE_STATE_PATH` | `.auth/storage-state.json` | Playwright session state path |
| `DISCOVER_PAGES` | — | Pages to visit during discovery |
| `PORT` | `3456` | Mock server port |
| `MOCK_DATA_PATH` | auto-detected | Path to `traffic.json` for mock server |
| `MOCK_FAULT_RATE` | `0` | Fault injection rate (0–1) |

See `.env.example` for the full list with descriptions.

---

## Architecture

```
specify/
├── scripts/
│   ├── browse-and-capture.mjs   # Interactive capture tool (primary)
│   ├── login.ts                 # Session capture via browser login
│   ├── cdp-capture.ts           # Passive CDP capture from existing Chrome
│   ├── api-discover.ts          # Autonomous API discovery engine
│   ├── live-discover.ts         # Live traffic intercept + discovery
│   └── live-discover-fetch.ts   # Browser-free discovery via Node fetch
├── src/
│   └── mock-server.ts           # HTTP replay server with fault injection
├── captures/                    # Capture output (gitignored)
├── docs/                        # Discovery reports (gitignored)
├── .auth/                       # Saved session state (gitignored)
├── .env.example                 # Configuration reference
└── package.json
```

### Dependencies

- **[Playwright](https://playwright.dev/)** — browser automation and network interception
- **[chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)** — CDP client for `cdp-capture.ts`
- **Node.js 20+** — native fetch, ESM modules
