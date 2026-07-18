/**
 * src/spec/formulas.ts — Compiled LTLf formulas sibling file.
 *
 * `specify.formulas.yaml` is a durable, reviewable artifact: plain-language
 * behavior descriptions get compiled (elsewhere) into finite-trace temporal
 * logic formulas (see src/monitor/formula.ts) that a deterministic monitor
 * evaluates over recorded run traces. Because formulas gate pass/fail
 * verdicts, this module is STRICT where src/agent/memory-layers.ts's
 * observations loader is tolerant: a malformed formulas file throws rather
 * than silently degrading to "no formulas". Callers that want tolerant
 * behavior (e.g. lint, which must report rather than crash) catch the error
 * explicitly — see lintFormulas in ./lint.ts.
 *
 * Schema (specify.formulas.yaml):
 *   version: 1
 *   predicates_version: 1
 *   formulas:
 *     - id: fml-<hash6>                     # stable, content-derived
 *       behavior: <area-id>/<behavior-id>    # fully-qualified
 *       description_hash: sha256:...         # of the behavior description at compile time
 *       formula: { ...LTLf AST... }          # validated against formula.ts's ajv schema
 *       predicates_used: [http.response, page.url]
 *       status: draft | approved | rejected
 *       provenance:
 *         compiled_by: <string>
 *         model: <string>            # optional
 *         session_id: <string>       # optional
 *         compiled_at: <ISO 8601>
 *
 * A behavior may have multiple formulas (a conjunction of separately
 * reviewed properties), so `formulas` is a list, not a map keyed by
 * behavior. Duplicate policing (same behavior + same AST) is a lint concern,
 * not a load-time concern — see lint.ts's duplicate-formula-id rule and
 * addDraft's dedupe-on-write behavior below.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { type Formula, validateFormula } from '../monitor/formula.js';
import { specRootDir } from './paths.js';

export type FormulaStatus = 'draft' | 'approved' | 'rejected';

export interface FormulaProvenance {
  compiled_by: string;
  model?: string;
  session_id?: string;
  compiled_at: string;
}

export interface FormulaEntry {
  id: string;
  /** Fully-qualified: "area-id/behavior-id". */
  behavior: string;
  /** "sha256:<hex>" of the behavior description at compile time. */
  description_hash: string;
  formula: Formula;
  predicates_used: string[];
  status: FormulaStatus;
  provenance: FormulaProvenance;
}

export interface FormulasFile {
  version: 1;
  predicates_version: 1;
  formulas: FormulaEntry[];
}

/** Thrown by loadFormulas when the sibling file is malformed. Formulas gate
 * verdicts, so a broken file must surface loudly rather than be silently
 * skipped (unlike src/agent/memory-layers.ts's tolerant observations load).
 * Callers that want tolerant behavior (e.g. lint) catch this explicitly. */
export class FormulasLoadError extends Error {
  constructor(
    message: string,
    /** Path to the file that failed to load. */
    public readonly filePath: string,
    /** Underlying cause, if any (parse error, ajv errors, etc). */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FormulasLoadError';
  }
}

export function defaultFormulasPath(specPath: string): string {
  return path.join(specRootDir(specPath), 'specify.formulas.yaml');
}

/** sha256 hex digest of a UTF-8 string, prefixed "sha256:" per the schema. */
export function hashDescription(description: string): string {
  return `sha256:${crypto.createHash('sha256').update(description, 'utf-8').digest('hex')}`;
}

/**
 * Derive a stable 6-hex-char id suffix from the behavior FQ id and the
 * formula AST content, so recompiling the exact same formula for the same
 * behavior reproduces the same id (used by addDraft's dedupe check).
 */
export function formulaId(behaviorFqId: string, formula: Formula): string {
  const canonical = JSON.stringify(formula);
  const hash = crypto
    .createHash('sha256')
    .update(`${behaviorFqId}\n${canonical}`, 'utf-8')
    .digest('hex')
    .slice(0, 6);
  return `fml-${hash}`;
}

function assertString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FormulasLoadError(`Formula entry missing required field "${field}"`, filePath);
  }
  return value;
}

const VALID_STATUSES: FormulaStatus[] = ['draft', 'approved', 'rejected'];

function validateEntry(raw: unknown, index: number, filePath: string): FormulaEntry {
  if (!raw || typeof raw !== 'object') {
    throw new FormulasLoadError(`Formula at index ${index} is not an object`, filePath);
  }
  const entry = raw as Record<string, unknown>;

  const id = assertString(entry.id, 'id', filePath);
  const behavior = assertString(entry.behavior, 'behavior', filePath);
  if (!behavior.includes('/')) {
    throw new FormulasLoadError(
      `Formula "${id}" has behavior "${behavior}" which is not fully-qualified (expected "area-id/behavior-id")`,
      filePath,
    );
  }
  const descriptionHash = assertString(entry.description_hash, 'description_hash', filePath);

  const { valid, errors } = validateFormula(entry.formula);
  if (!valid) {
    throw new FormulasLoadError(
      `Formula "${id}" has an invalid AST: ${errors.join('; ')}`,
      filePath,
    );
  }

  const predicatesUsed = Array.isArray(entry.predicates_used)
    ? entry.predicates_used.filter((p): p is string => typeof p === 'string')
    : [];

  const status = entry.status;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as FormulaStatus)) {
    throw new FormulasLoadError(
      `Formula "${id}" has invalid status "${String(status)}" (expected one of ${VALID_STATUSES.join(', ')})`,
      filePath,
    );
  }

  const provenanceRaw = entry.provenance;
  if (!provenanceRaw || typeof provenanceRaw !== 'object') {
    throw new FormulasLoadError(`Formula "${id}" is missing "provenance"`, filePath);
  }
  const provenanceObj = provenanceRaw as Record<string, unknown>;
  const compiledBy = assertString(provenanceObj.compiled_by, 'provenance.compiled_by', filePath);
  const compiledAt = assertString(provenanceObj.compiled_at, 'provenance.compiled_at', filePath);
  const provenance: FormulaProvenance = {
    compiled_by: compiledBy,
    compiled_at: compiledAt,
    ...(typeof provenanceObj.model === 'string' ? { model: provenanceObj.model } : {}),
    ...(typeof provenanceObj.session_id === 'string' ? { session_id: provenanceObj.session_id } : {}),
  };

  return {
    id,
    behavior,
    description_hash: descriptionHash,
    formula: entry.formula as Formula,
    predicates_used: predicatesUsed,
    status: status as FormulaStatus,
    provenance,
  };
}

/**
 * Load specify.formulas.yaml. Returns null when the file does not exist
 * (that's a legitimate "no formulas compiled yet" state, not an error).
 *
 * THROWS FormulasLoadError on any malformed content: bad YAML, non-object
 * root, wrong version, missing required fields, or a formula AST that
 * fails src/monitor/formula.ts's schema. Formulas gate verdicts, so a
 * silently-degraded load here would let a broken file masquerade as "zero
 * formulas" — deliberately unlike the tolerant load in
 * src/agent/memory-layers.ts's loadObservations.
 */
export function loadFormulas(filePath: string): FormulasFile | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new FormulasLoadError(`Failed to parse ${filePath} as YAML: ${(err as Error).message}`, filePath, err);
  }

  if (!raw || typeof raw !== 'object') {
    throw new FormulasLoadError(`${filePath} must contain a YAML object`, filePath);
  }
  const data = raw as Record<string, unknown>;

  if (data.version !== 1) {
    throw new FormulasLoadError(`${filePath} has unsupported version "${String(data.version)}" (expected 1)`, filePath);
  }
  if (data.predicates_version !== 1) {
    throw new FormulasLoadError(
      `${filePath} has unsupported predicates_version "${String(data.predicates_version)}" (expected 1)`,
      filePath,
    );
  }
  if (!Array.isArray(data.formulas)) {
    throw new FormulasLoadError(`${filePath} is missing a "formulas" array`, filePath);
  }

  const formulas = data.formulas.map((entry, i) => validateEntry(entry, i, filePath));

  return { version: 1, predicates_version: 1, formulas };
}

/**
 * Save specify.formulas.yaml atomically (tmp file + rename, matching
 * src/daemon/inbox-state.ts's saveMessage pattern) with a stable field
 * order per entry so diffs stay reviewable.
 */
export function saveFormulas(filePath: string, file: FormulasFile): void {
  const orderedFile = {
    version: file.version,
    predicates_version: file.predicates_version,
    formulas: file.formulas.map((entry) => orderEntry(entry)),
  };
  const body = yaml.dump(orderedFile, { sortKeys: false, lineWidth: 120 });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function orderEntry(entry: FormulaEntry): Record<string, unknown> {
  return {
    id: entry.id,
    behavior: entry.behavior,
    description_hash: entry.description_hash,
    formula: entry.formula,
    predicates_used: entry.predicates_used,
    status: entry.status,
    provenance: {
      compiled_by: entry.provenance.compiled_by,
      ...(entry.provenance.model !== undefined ? { model: entry.provenance.model } : {}),
      ...(entry.provenance.session_id !== undefined ? { session_id: entry.provenance.session_id } : {}),
      compiled_at: entry.provenance.compiled_at,
    },
  };
}

/** Find all formulas for a given fully-qualified behavior id. */
export function findFormulas(file: FormulasFile, behaviorFqId: string): FormulaEntry[] {
  return file.formulas.filter((f) => f.behavior === behaviorFqId);
}

/**
 * Add a draft formula to the file, deduping on (behavior, formula AST):
 * if an entry with the same behavior and a structurally identical formula
 * already exists, returns the file unchanged (the existing entry, not a
 * duplicate, is authoritative). Otherwise appends and returns the new
 * entry alongside the updated file.
 */
export function addDraft(
  file: FormulasFile,
  entry: {
    behavior: string;
    formula: Formula;
    description_hash: string;
    predicates_used: string[];
    provenance: FormulaProvenance;
  },
): { file: FormulasFile; entry: FormulaEntry; deduped: boolean } {
  const canonical = JSON.stringify(entry.formula);
  const existing = file.formulas.find(
    (f) => f.behavior === entry.behavior && JSON.stringify(f.formula) === canonical,
  );
  if (existing) {
    return { file, entry: existing, deduped: true };
  }

  const newEntry: FormulaEntry = {
    id: formulaId(entry.behavior, entry.formula),
    behavior: entry.behavior,
    description_hash: entry.description_hash,
    formula: entry.formula,
    predicates_used: entry.predicates_used,
    status: 'draft',
    provenance: entry.provenance,
  };

  return {
    file: { ...file, formulas: [...file.formulas, newEntry] },
    entry: newEntry,
    deduped: false,
  };
}

/** Update the status of a formula by id. Throws if no formula has that id. */
export function setStatus(file: FormulasFile, id: string, status: FormulaStatus): FormulasFile {
  const idx = file.formulas.findIndex((f) => f.id === id);
  if (idx === -1) {
    throw new Error(`No formula with id "${id}"`);
  }
  const formulas = file.formulas.slice();
  formulas[idx] = { ...formulas[idx], status };
  return { ...file, formulas };
}

/** Empty file skeleton, useful for callers building up a file from scratch. */
export function emptyFormulasFile(): FormulasFile {
  return { version: 1, predicates_version: 1, formulas: [] };
}

/** Walk a formula AST and collect every distinct predicate name referenced. */
export function collectPredicateNames(formula: Formula): string[] {
  const names = new Set<string>();
  const visit = (f: Formula): void => {
    switch (f.op) {
      case 'pred':
        names.add(f.name);
        return;
      case 'not':
      case 'X':
      case 'F':
      case 'G':
        visit(f.arg);
        return;
      case 'and':
      case 'or':
        for (const arg of f.args) visit(arg);
        return;
      case 'implies':
        visit(f.left);
        visit(f.right);
        return;
      case 'U':
        visit(f.left);
        visit(f.right);
        break;
    }
  };
  visit(formula);
  return [...names];
}
