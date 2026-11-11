import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OpenSpecScan } from './openspec.js';
import { scanSpecMarkdown } from './openspec.js';
import type { FormalCheck } from './types.js';

export const LOCK_FILE = path.join('formal', 'specify.lock');

export interface LockLink {
  /** The link without its expectation, e.g. `quint formal/c.qnt safe invariant tlc main=Counter`. */
  link: string;
  expect: 'holds' | 'fails';
  /** Hash of the property or theorem statement text (`file:` prefix: whole file). */
  definition: string;
}

export type LockEntry = { links: LockLink[] } | { waived: string };

export interface Lock {
  version: 1;
  requirements: Record<string, LockEntry>;
}

export type WeakeningKind =
  | 'requirement-removed'
  | 'waived'
  | 'link-removed'
  | 'expect-flipped'
  | 'definition-changed';

export interface Weakening {
  kind: WeakeningKind;
  requirementId: string;
  detail: string;
  /** True when an OpenSpec change proposal names the requirement. */
  covered: boolean;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function squash(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function isQuintDeclaration(line: string): boolean {
  const text = line.trim().replace(/^pure\s+/, '');
  return (
    text.startsWith('}') ||
    text.startsWith('//') ||
    /^(val|def|temporal|action|var|const|type|import|export|module|run|nondet)\b/.test(text)
  );
}

/** The text that defines a linked property, so edits to it show up in the lock. */
export function definitionText(source: string, check: FormalCheck): string | undefined {
  if (check.tool === 'lean') {
    const short = check.property.split('.').at(-1) ?? check.property;
    for (const match of source.matchAll(/\btheorem\s+([^\s:({[]+)/g)) {
      if (match[1] !== short) continue;
      const end = source.indexOf(':=', match.index);
      return end === -1 ? undefined : squash(source.slice(match.index, end + 2));
    }
    return undefined;
  }
  let lines = source.split(/\r?\n/);
  if (check.main) {
    const start = lines.findIndex((line) => /^\s*module\s+(\w+)/.exec(line)?.[1] === check.main);
    if (start === -1) return undefined;
    lines = lines.slice(start + 1);
  }
  const declares = (line: string): boolean =>
    /^(?:val|def|temporal)\s+(\w+)/.exec(line.trim().replace(/^pure\s+/, ''))?.[1] ===
    check.property;
  const first = lines.findIndex((line) => declares(line));
  if (first === -1) return undefined;
  const body = [lines[first]];
  for (const line of lines.slice(first + 1)) {
    if (!line.trim() || isQuintDeclaration(line)) break;
    body.push(line);
  }
  return squash(body.join(' '));
}

function definitionHash(root: string, check: FormalCheck): string {
  let source: string;
  try {
    source = fs.readFileSync(path.resolve(root, check.file), 'utf8');
  } catch {
    return 'missing';
  }
  const text = definitionText(source, check);
  return text === undefined ? `file:${sha(source)}` : sha(text);
}

function linkKey(check: FormalCheck): string {
  if (check.tool === 'lean') return `lean ${check.file} ${check.property}`;
  const backend = check.mode === 'simulate' ? 'simulate' : check.backend;
  const main = check.main ? ` main=${check.main}` : '';
  return `quint ${check.file} ${check.property} ${check.kind} ${backend}${main}`;
}

/** The lock for the main specs: every link's identity, expectation and property text hash. */
export function buildLock(root: string, scan: OpenSpecScan): Lock {
  const requirements: Record<string, LockEntry> = {};
  const ids = [...new Set(scan.requirementIds)].sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    const links = scan.references
      .filter((ref) => ref.requirementId === id)
      .flatMap((ref) => (ref.check ? [ref.check] : []))
      .map((check) => ({
        link: linkKey(check),
        expect: check.expect,
        definition: definitionHash(root, check),
      }))
      .sort((a, b) => a.link.localeCompare(b.link));
    const waiver = scan.waivers.find((entry) => entry.requirementId === id);
    if (links.length) requirements[id] = { links };
    else if (waiver) requirements[id] = { waived: waiver.reason };
  }
  return { version: 1, requirements };
}

export function serializeLock(lock: Lock): string {
  return JSON.stringify(lock, null, 2) + '\n';
}

export function parseLock(text: string): Lock {
  const lock = JSON.parse(text) as Lock;
  if (lock.version !== 1 || typeof lock.requirements !== 'object' || lock.requirements === null) {
    throw new Error(`${LOCK_FILE} is not a version 1 lock`);
  }
  return lock;
}

/**
 * What `current` no longer guarantees compared with `base`: a dropped requirement or link, a link
 * turned into a waiver, a flipped expectation, or an edited property. An edit cannot be told apart
 * from a weakening, so every edit needs a change proposal.
 */
export function diffLocks(base: Lock, current: Lock, covered: Set<string>): Weakening[] {
  const weakenings: Weakening[] = [];
  for (const [requirementId, before] of Object.entries(base.requirements)) {
    if (!('links' in before)) continue;
    const add = (kind: WeakeningKind, detail: string): void => {
      weakenings.push({ kind, requirementId, detail, covered: covered.has(requirementId) });
    };
    const after = current.requirements[requirementId];
    if (!after) {
      add('requirement-removed', 'the requirement and its formal links are gone');
      continue;
    }
    if (!('links' in after)) {
      add('waived', `formal links were replaced by a waiver (${after.waived})`);
      continue;
    }
    for (const link of before.links) {
      const now = after.links.find((entry) => entry.link === link.link);
      if (!now) add('link-removed', link.link);
      else if (now.expect !== link.expect) {
        add('expect-flipped', `${link.link}: expect=${link.expect} became expect=${now.expect}`);
      } else if (now.definition !== link.definition) {
        add('definition-changed', `${link.link}: the property text changed`);
      }
    }
  }
  return weakenings;
}

/**
 * Requirements named by an OpenSpec change proposal: every active change, plus archived changes
 * among `changed` files (a change archived in the same diff still covers its requirements).
 */
export function coveredByChanges(root: string, changed: Set<string> | undefined): Set<string> {
  const covered = new Set<string>();
  const changesDir = path.join(root, 'openspec', 'changes');
  const specFiles: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'spec.md') specFiles.push(full);
    }
  };
  if (fs.existsSync(changesDir)) {
    for (const entry of fs.readdirSync(changesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'archive') walk(path.join(changesDir, entry.name));
    }
  }
  for (const file of changed ?? []) {
    if (/^openspec\/changes\/archive\/.+\/specs\/.+\/spec\.md$/.test(file)) {
      const full = path.join(root, file);
      if (fs.existsSync(full)) specFiles.push(full);
    }
  }
  for (const file of specFiles) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const capability = /\/specs\/(.+)\/spec\.md$/.exec(relative)?.[1];
    if (!capability) continue;
    const scan = scanSpecMarkdown(fs.readFileSync(file, 'utf8'), capability, relative);
    for (const id of [...scan.requirementIds, ...scan.removedIds]) covered.add(id);
  }
  return covered;
}
