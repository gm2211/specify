import fs from 'node:fs';
import path from 'node:path';
import type { FormalSource, VerifyLink } from './types.js';

export interface TestCase {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
}

export type VerifyStatus = 'passed' | 'failed' | 'skipped' | 'missing' | 'no-report' | 'invalid';

export interface VerifyResult {
  requirementId: string;
  source: FormalSource;
  test?: string;
  status: VerifyStatus;
  /** How many test cases matched the name. */
  matched: number;
  ok: boolean;
  message?: string;
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

function decode(value: string): string {
  return value.replaceAll(/&(?:quot|apos|lt|gt|amp);/g, (entity) => ENTITIES[entity]);
}

/** Read test cases from a JUnit XML or TAP report. Specify reads reports; it never runs tests. */
export function parseTestReport(text: string): TestCase[] {
  return text.trimStart().startsWith('<') ? parseJunit(text) : parseTap(text);
}

function parseJunit(text: string): TestCase[] {
  const cases: TestCase[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of text.matchAll(pattern)) {
    const rawName = /\bname="([^"]*)"/.exec(match[1])?.[1];
    if (rawName === undefined) continue;
    const name = decode(rawName);
    const rawClass = /\bclassname="([^"]*)"/.exec(match[1])?.[1];
    const classname = rawClass === undefined ? undefined : decode(rawClass);
    const body = match[2] ?? '';
    let status: TestCase['status'] = 'passed';
    if (/<(failure|error)\b/.test(body)) status = 'failed';
    else if (/<skipped\b/.test(body)) status = 'skipped';
    cases.push({ name: classname ? `${classname} ${name}` : name, status });
  }
  return cases;
}

function parseTap(text: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const passed = line.startsWith('ok');
    if (!passed && !line.startsWith('not ok')) continue;
    const rest = line
      .slice(passed ? 2 : 6)
      .trim()
      .replace(/^\d+/, '')
      .trim()
      .replace(/^-\s*/, '');
    const [name, directive = ''] = rest.split(/\s+#\s*/, 2);
    let status: TestCase['status'] = passed ? 'passed' : 'failed';
    if (/^(skip|todo)/i.test(directive)) status = 'skipped';
    cases.push({ name: name.trim(), status });
  }
  return cases;
}

/** Load every configured report that exists. `undefined` means no report was found at all. */
export function loadTestReports(root: string, files: string[]): TestCase[] | undefined {
  const cases: TestCase[] = [];
  let found = false;
  for (const file of files) {
    const full = path.resolve(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    found = true;
    cases.push(...parseTestReport(fs.readFileSync(full, 'utf8')));
  }
  return found ? cases : undefined;
}

/** A link passes only when at least one matching test passed and none failed. */
export function checkVerifyLinks(
  links: VerifyLink[],
  cases: TestCase[] | undefined,
): VerifyResult[] {
  return links.map((link) => {
    const base = { requirementId: link.requirementId, source: link.source };
    if (!link.test) {
      return { ...base, status: 'invalid', matched: 0, ok: false, message: link.error };
    }
    const result = { ...base, test: link.test };
    if (!cases) {
      return {
        ...result,
        status: 'no-report',
        matched: 0,
        ok: false,
        message:
          'no test report found; set testReports in formal/specify.json or pass --test-report',
      };
    }
    const matches = cases.filter((entry) => entry.name.includes(link.test as string));
    const count = (status: TestCase['status']): number =>
      matches.filter((entry) => entry.status === status).length;
    let status: VerifyStatus = 'passed';
    if (!matches.length) status = 'missing';
    else if (count('failed')) status = 'failed';
    else if (!count('passed')) status = 'skipped';
    return {
      ...result,
      status,
      matched: matches.length,
      ok: status === 'passed',
      ...(status === 'passed' ? {} : { message: `test "${link.test}" is ${status}` }),
    };
  });
}
