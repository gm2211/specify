import fs from 'node:fs';
import path from 'node:path';

/** `strict` fails the gate on policy findings; `warn` only reports them. */
export type Policy = 'strict' | 'warn';

export interface SpecifyConfig {
  policy: Policy;
  /** JUnit XML or TAP files written by the project's own test run, relative to the root. */
  testReports: string[];
}

export const CONFIG_FILE = path.join('formal', 'specify.json');

/** Read `formal/specify.json`. A project without one gets the `warn` policy and no test reports. */
export function loadConfig(root: string): SpecifyConfig {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return { policy: 'warn', testReports: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILE} must be a JSON object`);
  }
  const { policy = 'warn', testReports = [], ...unknown } = raw as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length) throw new Error(`${CONFIG_FILE} has unknown keys: ${extra.join(', ')}`);
  if (policy !== 'strict' && policy !== 'warn') {
    throw new Error(`${CONFIG_FILE}: policy must be "strict" or "warn"`);
  }
  if (!Array.isArray(testReports) || testReports.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${CONFIG_FILE}: testReports must be a list of file paths`);
  }
  return { policy, testReports: testReports as string[] };
}
