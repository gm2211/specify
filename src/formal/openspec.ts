import fs from 'node:fs';
import path from 'node:path';
import type { FormalCheck, FormalSource, FormalWaiver, VerifyLink } from './types.js';

/**
 * Reads `Formal:` lines from OpenSpec specs. OpenSpec owns the spec format; Specify only reads
 * the requirement headers and the formal links written under them:
 *
 *   ### Requirement: Resumed worker works again
 *   ...
 *   Formal: quint formal/snooze.qnt eventuallyWorking temporal expect=holds
 */

export interface FormalReference {
  requirementId: string;
  source: FormalSource;
  check?: FormalCheck;
  /** Set when the line could not be parsed into a check. */
  error?: string;
}

export interface OpenSpecScan {
  references: FormalReference[];
  requirementIds: string[];
  /** Requirements listed under a delta spec's `## REMOVED Requirements`. */
  removedIds: string[];
  /** `Formal: none (reason)` waivers. */
  waivers: FormalWaiver[];
  /** `Verify:` lines linking requirements to tests. */
  verifies: VerifyLink[];
}

const REQUIREMENT = /^###\s+Requirement:(.*)$/;
const SECTION_END = /^#{1,3}\s/;
const FENCE = /^\s*(```|~~~)/;
const FORMAL = /^(?:\*\*|__)?Formal:(?:\*\*|__)?(.*)$/;
const VERIFY = /^(?:\*\*|__)?Verify:(?:\*\*|__)?(.*)$/;

/** Find every `spec.md` under a specs directory (`openspec/specs` or a change's `specs`). */
export function findSpecFiles(specsDir: string): string[] {
  if (!fs.existsSync(specsDir) || !fs.statSync(specsDir).isDirectory()) {
    throw new Error(`No OpenSpec specs at ${specsDir}. Run \`specify init\` first.`);
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'spec.md') files.push(full);
    }
  };
  walk(specsDir);
  return files;
}

/**
 * Scan main specs, optionally overlaid with an OpenSpec change's delta specs: a requirement the
 * change adds or modifies replaces the main one's links, and one it removes disappears.
 */
export function scanOpenSpec(root: string, change?: string): OpenSpecScan {
  const main = scanSpecsDir(root, path.join(root, 'openspec', 'specs'));
  if (!change) return main;
  if (!/^[\w.-]+$/.test(change) || change === 'archive') {
    throw new Error(`Invalid change name: ${change}`);
  }
  const delta = scanSpecsDir(root, path.join(root, 'openspec', 'changes', change, 'specs'));
  const replaced = new Set([...delta.requirementIds, ...delta.removedIds]);
  const requirementIds = [
    ...main.requirementIds.filter((id) => !replaced.has(id)),
    ...delta.requirementIds,
  ];
  const kept = <T extends { requirementId: string }>(items: T[]): T[] =>
    items.filter((item) => !replaced.has(item.requirementId));
  return {
    references: [...kept(main.references), ...delta.references],
    requirementIds: [...new Set(requirementIds)],
    removedIds: delta.removedIds,
    waivers: [...kept(main.waivers), ...delta.waivers],
    verifies: [...kept(main.verifies), ...delta.verifies],
  };
}

/** Active OpenSpec changes: directories under `openspec/changes` (except `archive`) with delta specs. */
export function listActiveChanges(root: string): string[] {
  const dir = path.join(root, 'openspec', 'changes');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'archive' &&
        /^[\w.-]+$/.test(entry.name) &&
        fs.existsSync(path.join(dir, entry.name, 'specs')),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function scanSpecsDir(root: string, specsDir: string): OpenSpecScan {
  const result: OpenSpecScan = {
    references: [],
    requirementIds: [],
    removedIds: [],
    waivers: [],
    verifies: [],
  };
  for (const file of findSpecFiles(specsDir)) {
    const capability = toPosix(path.relative(specsDir, path.dirname(file))) || '.';
    const relativeFile = toPosix(path.relative(root, file));
    const scanned = scanSpecMarkdown(fs.readFileSync(file, 'utf8'), capability, relativeFile);
    result.references.push(...scanned.references);
    result.requirementIds.push(...scanned.requirementIds);
    result.removedIds.push(...scanned.removedIds);
    result.waivers.push(...scanned.waivers);
    result.verifies.push(...scanned.verifies);
  }
  return result;
}

/** Parse one spec.md. Exported for tests. */
export function scanSpecMarkdown(text: string, capability: string, file: string): OpenSpecScan {
  const references: FormalReference[] = [];
  const requirementIds: string[] = [];
  const removedIds: string[] = [];
  const waivers: FormalWaiver[] = [];
  const verifies: VerifyLink[] = [];
  let removedSection = false;
  let current: string | undefined;
  let fence: string | undefined;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const requirement = REQUIREMENT.exec(line);
    const name = requirement?.[1].replace(/#+\s*$/, '').trim();
    if (name) {
      if (removedSection) {
        removedIds.push(`${capability}/${name}`);
        current = undefined;
      } else {
        current = `${capability}/${name}`;
        requirementIds.push(current);
      }
      continue;
    }
    if (SECTION_END.test(line)) {
      current = undefined;
      if (/^##\s/.test(line)) removedSection = /^##\s+REMOVED\b/i.test(line);
      continue;
    }
    const item = line.trim().replace(/^[-*+]\s+/, '');
    const source: FormalSource = { file, line: index + 1, text: line.trim() };
    const verify = VERIFY.exec(item);
    if (verify) {
      verifies.push({
        requirementId: current ?? `${capability}/(none)`,
        source,
        ...(current
          ? parseVerifyLine(verify[1])
          : { error: 'Verify line is not under a "### Requirement:" heading' }),
      });
      continue;
    }
    const formal = FORMAL.exec(item);
    if (!formal) continue;
    const reason = current ? waiverReason(formal[1]) : undefined;
    if (current && reason !== undefined) {
      if (reason) waivers.push({ requirementId: current, reason, source });
      else {
        references.push({
          requirementId: current,
          source,
          error: 'A waiver needs a reason: "Formal: none (why this is not modeled)"',
        });
      }
      continue;
    }
    if (!current) {
      references.push({
        requirementId: `${capability}/(none)`,
        source,
        error: 'Formal line is not under a "### Requirement:" heading',
      });
      continue;
    }
    try {
      references.push({ requirementId: current, source, check: parseFormalLine(formal[1]) });
    } catch (error) {
      references.push({
        requirementId: current,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { references, requirementIds, removedIds, waivers, verifies };
}

/** The reason of a `none (<reason>)` waiver; `undefined` when the line is not a waiver. */
function waiverReason(raw: string): string | undefined {
  const [word, ...rest] = unquote(raw).split(/\s+/);
  if (word !== 'none') return undefined;
  return rest
    .join(' ')
    .replace(/^\((.*)\)$/, '$1')
    .trim();
}

function unquote(raw: string): string {
  return raw
    .trim()
    .replace(/^`(.*)`$/, '$1')
    .trim();
}

/** Grammar: `test <name>`; the name may be quoted and is matched as a substring of test case names. */
function parseVerifyLine(raw: string): { test: string } | { error: string } {
  const match = /^test\s+(.+)$/.exec(unquote(raw));
  const name = match?.[1].replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!name) return { error: 'Expected "Verify: test <test name>"' };
  return { test: name };
}

const QUINT_KEYS = new Set(['expect', 'backend', 'mode', 'main', 'max-steps', 'samples', 'seed']);
const LEAN_KEYS = new Set(['expect']);

/**
 * Grammar (whitespace separated, paths without spaces):
 *   quint <file> <property> [invariant|temporal] [expect=holds|fails] [backend=tlc|apalache]
 *         [mode=verify|simulate] [main=<module>] [max-steps=N] [samples=N] [seed=N]
 *   lean <file> <Namespace.theorem>
 */
export function parseFormalLine(raw: string): FormalCheck {
  const body = unquote(raw);
  if (body.includes('Formal:')) {
    throw new Error(
      'Several Formal: links share one line, often because a Markdown formatter joined them; put each on its own list item',
    );
  }
  const [tool, file, property, ...rest] = body.split(/\s+/).filter(Boolean);
  if (!tool || !file || !property) {
    throw new Error('Expected "Formal: <quint|lean> <file> <property> [options]"');
  }
  const options = new Map<string, string>();
  const bare: string[] = [];
  for (const token of rest) {
    const eq = token.indexOf('=');
    if (eq === -1) {
      bare.push(token);
      continue;
    }
    const key = token.slice(0, eq);
    if (options.has(key)) throw new Error(`Repeated option ${key}`);
    options.set(key, token.slice(eq + 1));
  }

  if (tool === 'lean') {
    if (bare.length) throw new Error(`Unknown Lean option ${bare[0]}`);
    rejectUnknown(options, LEAN_KEYS, 'Lean');
    const expect = options.get('expect') ?? 'holds';
    if (expect !== 'holds') {
      throw new Error('Lean links support expect=holds only; a theorem cannot be expected to fail');
    }
    return { tool: 'lean', file, property, expect: 'holds' };
  }
  if (tool !== 'quint') throw new Error(`Unknown formal tool ${tool}; use quint or lean`);

  rejectUnknown(options, QUINT_KEYS, 'Quint');
  if (bare.length > 1) throw new Error(`Unexpected tokens: ${bare.join(' ')}`);
  const kind = bare[0] ?? 'invariant';
  if (kind !== 'invariant' && kind !== 'temporal') {
    throw new Error(`Unknown property kind ${kind}; use invariant or temporal`);
  }
  const expect = oneOf(options.get('expect') ?? 'holds', ['holds', 'fails'], 'expect');
  const mode = oneOf(options.get('mode') ?? 'verify', ['verify', 'simulate'], 'mode');
  const main = options.get('main');
  const maxSteps = integer(options, 'max-steps');
  const samples = integer(options, 'samples');
  const seed = integer(options, 'seed');

  if (mode === 'simulate') {
    if (options.has('backend')) throw new Error('backend applies to mode=verify only');
    if (kind === 'temporal') throw new Error('Temporal properties need mode=verify');
    if (samples === undefined || seed === undefined || maxSteps === undefined) {
      throw new Error('mode=simulate requires max-steps, samples and seed');
    }
    return {
      tool: 'quint',
      file,
      property,
      kind,
      mode,
      backend: 'typescript',
      expect,
      maxSteps,
      samples,
      seed,
      ...(main ? { main } : {}),
    };
  }

  if (samples !== undefined || seed !== undefined) {
    throw new Error('samples and seed apply to mode=simulate only');
  }
  const backend = oneOf(options.get('backend') ?? 'tlc', ['tlc', 'apalache'], 'backend');
  if (backend === 'tlc' && maxSteps !== undefined) {
    throw new Error('TLC explores every reachable state; max-steps applies to apalache only');
  }
  return {
    tool: 'quint',
    file,
    property,
    kind,
    mode,
    backend,
    expect,
    ...(backend === 'apalache' ? { maxSteps: maxSteps ?? 10 } : {}),
    ...(main ? { main } : {}),
  };
}

function rejectUnknown(options: Map<string, string>, allowed: Set<string>, label: string): void {
  for (const key of options.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} option ${key}`);
  }
}

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join(', ')}; got ${value}`);
  }
  return value as T;
}

function integer(options: Map<string, string>, key: string): number | undefined {
  const value = options.get(key);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a nonnegative integer`);
  return Number(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
