import fs from 'node:fs';
import path from 'node:path';
import type { FormalCheck, FormalSource } from './types.js';

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
}

const REQUIREMENT = /^###\s+Requirement:(.*)$/;
const SECTION_END = /^#{1,3}\s/;
const FENCE = /^\s*(```|~~~)/;
const FORMAL = /^(?:\*\*|__)?Formal:(?:\*\*|__)?(.*)$/;

/** Find every OpenSpec main spec (`openspec/specs/<capability>/spec.md`) under a root. */
export function findSpecFiles(root: string): string[] {
  const specsDir = path.join(root, 'openspec', 'specs');
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

export function scanOpenSpec(root: string): OpenSpecScan {
  const references: FormalReference[] = [];
  const requirementIds: string[] = [];
  const specsDir = path.join(root, 'openspec', 'specs');
  for (const file of findSpecFiles(root)) {
    const capability = toPosix(path.relative(specsDir, path.dirname(file))) || '.';
    const relativeFile = toPosix(path.relative(root, file));
    const scanned = scanSpecMarkdown(fs.readFileSync(file, 'utf8'), capability, relativeFile);
    references.push(...scanned.references);
    requirementIds.push(...scanned.requirementIds);
  }
  return { references, requirementIds };
}

/** Parse one spec.md. Exported for tests. */
export function scanSpecMarkdown(text: string, capability: string, file: string): OpenSpecScan {
  const references: FormalReference[] = [];
  const requirementIds: string[] = [];
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
      current = `${capability}/${name}`;
      requirementIds.push(current);
      continue;
    }
    if (SECTION_END.test(line)) {
      current = undefined;
      continue;
    }
    const formal = FORMAL.exec(line.trim().replace(/^[-*+]\s+/, ''));
    if (!formal) continue;
    const source: FormalSource = { file, line: index + 1, text: line.trim() };
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
  return { references, requirementIds };
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
  const body = raw
    .trim()
    .replace(/^`(.*)`$/, '$1')
    .trim();
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
