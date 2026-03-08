/**
 * scripts/login.ts — Generic session capture via interactive browser login
 *
 * What it does:
 *   1. Launches a visible Chromium browser
 *   2. Navigates to the login URL (TARGET_LOGIN_URL or TARGET_BASE_URL)
 *   3. Waits for you to log in manually
 *   4. Captures all cookies and Playwright storage state after you press Enter
 *   5. Saves to .auth/cookies.json and .auth/storage-state.json
 *
 * Usage:
 *   npm run login
 *   TARGET_BASE_URL=https://app.example.com npm run login
 *
 * Configuration (via .env or environment variables):
 *   TARGET_BASE_URL       — base URL of the app (required)
 *   TARGET_LOGIN_URL      — login page URL (defaults to TARGET_BASE_URL)
 *   AUTH_COOKIE_NAMES     — comma-separated cookie names to look for (optional)
 *   AUTH_DIR              — directory to save auth files (default: .auth)
 *
 * Output:
 *   .auth/cookies.json        — raw cookies
 *   .auth/storage-state.json  — Playwright storage state (cookies + localStorage)
 */

import { chromium } from 'playwright';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AUTH_DIR = path.resolve(process.cwd(), process.env.AUTH_DIR ?? '.auth');
const COOKIES_FILE = path.join(AUTH_DIR, 'cookies.json');
const STORAGE_STATE_FILE = path.join(AUTH_DIR, 'storage-state.json');

const BASE_URL = process.env.TARGET_BASE_URL;
const LOGIN_URL_RAW = process.env.TARGET_LOGIN_URL ?? BASE_URL;

if (!LOGIN_URL_RAW) {
  console.error('ERROR: TARGET_BASE_URL or TARGET_LOGIN_URL must be set.');
  console.error('  Example: TARGET_BASE_URL=https://app.example.com npm run login');
  process.exit(1);
}

const LOGIN_URL: string = LOGIN_URL_RAW as string;

// Cookie names to look for to confirm successful auth
const AUTH_COOKIE_NAMES: string[] = (process.env.AUTH_COOKIE_NAMES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('Launching Chromium browser...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Track all pages (tabs) opened in this browser context
    const allPages: import('playwright').Page[] = [page];
    context.on('page', (newPage) => {
      console.log(`  New tab detected: ${newPage.url()}`);
      allPages.push(newPage);
    });

    console.log(`Navigating to ${LOGIN_URL}...`);
    await page.goto(LOGIN_URL);

    console.log('');
    console.log('='.repeat(70));
    console.log('Please log in in the browser window.');
    console.log('If the app opens a new tab after login, that\'s fine — we capture all tabs.');
    console.log('Press Enter in this terminal when you are on the post-login dashboard.');
    console.log('='.repeat(70));
    console.log('');

    await waitForEnter();

    // Wait a moment for any final cookie writes
    await new Promise((r) => setTimeout(r, 1000));

    console.log(`Capturing session data from ${allPages.length} tab(s)...`);

    const cookies = await context.cookies();
    const storageState = await context.storageState();

    // Ensure .auth directory exists
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      console.log(`Created directory: ${AUTH_DIR}`);
    }

    // Save cookies
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2), 'utf-8');
    console.log(`Saved cookies to: ${COOKIES_FILE}`);

    // Save full storage state
    fs.writeFileSync(STORAGE_STATE_FILE, JSON.stringify(storageState, null, 2), 'utf-8');
    console.log(`Saved storage state to: ${STORAGE_STATE_FILE}`);

    // Print summary
    console.log('');
    console.log('='.repeat(70));
    console.log('SESSION CAPTURE SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total cookies captured: ${cookies.length}`);

    const domains = [...new Set(cookies.map((c) => c.domain))];
    console.log(`Domains: ${domains.join(', ')}`);

    // Look for configured auth cookie names
    if (AUTH_COOKIE_NAMES.length > 0) {
      const authCookie = cookies.find((c) => AUTH_COOKIE_NAMES.includes(c.name));

      if (authCookie) {
        console.log('');
        console.log(`*** Auth cookie FOUND: ${authCookie.name} ***`);
        console.log(`  Domain:  ${authCookie.domain}`);
        console.log(`  Secure:  ${authCookie.secure}`);
        console.log(
          `  Expires: ${authCookie.expires > 0 ? new Date(authCookie.expires * 1000).toISOString() : 'session'}`
        );

        // Attempt JWT payload decode (works for JWT cookies)
        try {
          const parts = authCookie.value.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
            console.log('  JWT payload:');
            for (const [k, v] of Object.entries(payload)) {
              if (k === 'exp' && typeof v === 'number') {
                console.log(`    ${k}: ${new Date(v * 1000).toISOString()} (Unix ${v})`);
              } else {
                console.log(`    ${k}: ${v}`);
              }
            }
          }
        } catch {
          // Not a JWT or not decodeable — skip silently
        }
      } else {
        console.log('');
        console.log(
          `WARNING: None of the expected auth cookies found (${AUTH_COOKIE_NAMES.join(', ')}).`
        );
        console.log('You may not be fully logged in yet, or AUTH_COOKIE_NAMES needs updating.');
      }
    } else {
      // No configured auth cookies — just show all cookie names
      console.log('');
      console.log('Cookies found:');
      for (const c of cookies) {
        console.log(`  ${c.name} (${c.domain})`);
      }
    }

    console.log('='.repeat(70));
    console.log('');
    console.log('Done! You can close the browser or it will close automatically.');
  } catch (err) {
    console.error('Error during session capture:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

main();
