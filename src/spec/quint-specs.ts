/**
 * src/spec/quint-specs.ts — Durable, reviewable store for hand-modeled Quint
 * specs (SP-i35), mirroring src/spec/formulas.ts's draft/approve lifecycle.
 *
 * `specify.quint.yaml` is a sibling of the spec, holding the Quint (`.qnt`)
 * source for the 2-3 critical flows a team chose to model formally, plus each
 * spec's review status. It exists for the SAME reason the compiled-formulas file
 * does: an LLM DRAFTS the model, but there is no published evidence that
 * LLM-authored specs in this language are reliable, so a spec is INERT until a
 * human reviews it and flips its status to `approved`. Only an approved spec is
 * ever simulated (`quint run`) or bridged into an executable trace. Because a
 * spec gates real test generation, this loader is STRICT — a malformed file
 * throws rather than silently degrading to "no specs" — exactly like
 * formulas.ts and unlike the tolerant observation loader.
 *
 * Schema (specify.quint.yaml):
 *   version: 1
 *   specs:
 *     - id: qnt-<hash6>                       # stable, content-derived
 *       flow: <area-id>/<behavior-id>          # the critical flow this models
 *       description_hash: sha256:...           # of the flow narrative at draft time
 *       spec_text: |                           # the Quint source
 *         module auth { ... }
 *       predicates_used: [http.response, page.url]   # grounded predicates the model names
 *       status: draft | approved | rejected
 *       provenance:
 *         drafted_by: <string>
 *         model: <string>            # optional
 *         session_id: <string>       # optional
 *         drafted_at: <ISO 8601>
 *
 * A flow may have multiple drafted specs over its lifetime (a re-draft against
 * edited narrative), so `specs` is a list, not a map keyed by flow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { specRootDir } from './paths.js';

export type QuintSpecStatus = 'draft' | 'approved' | 'rejected';

export interface QuintSpecProvenance {
  drafted_by: string;
  model?: string;
  session_id?: string;
  drafted_at: string;
}

export interface QuintSpecEntry {
  id: string;
  /** Fully-qualified critical flow: "area-id/behavior-id". */
  flow: string;
  /** "sha256:<hex>" of the flow narrative at draft time. */
  description_hash: string;
  /** The Quint (`.qnt`) source text. */
  spec_text: string;
  /** Grounded predicate names the model is written over (advisory; the bridge re-checks). */
  predicates_used: string[];
  status: QuintSpecStatus;
  provenance: QuintSpecProvenance;
}

export interface QuintSpecsFile {
  version: 1;
  specs: QuintSpecEntry[];
}

/** Thrown by loadQuintSpecs when the sibling file is malformed. Mirrors FormulasLoadError. */
export class QuintSpecsLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'QuintSpecsLoadError';
  }
}

export function defaultQuintSpecsPath(specPath: string): string {
  return path.join(specRootDir(specPath), 'specify.quint.yaml');
}

/** sha256 hex digest of a UTF-8 string, prefixed "sha256:" per the schema. */
export function hashNarrative(narrative: string): string {
  return `sha256:${crypto.createHash('sha256').update(narrative, 'utf-8').digest('hex')}`;
}

/**
 * Derive a stable 6-hex-char id from the flow id and the spec text, so
 * re-drafting the exact same spec for the same flow reproduces the same id
 * (used by addDraft's dedupe check).
 */
export function quintSpecId(flowFqId: string, specText: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${flowFqId}\n${specText}`, 'utf-8')
    .digest('hex')
    .slice(0, 6);
  return `qnt-${hash}`;
}

function assertString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QuintSpecsLoadError(`Quint spec entry missing required field "${field}"`, filePath);
  }
  return value;
}

const VALID_STATUSES: QuintSpecStatus[] = ['draft', 'approved', 'rejected'];

function validateEntry(raw: unknown, index: number, filePath: string): QuintSpecEntry {
  if (!raw || typeof raw !== 'object') {
    throw new QuintSpecsLoadError(`Quint spec at index ${index} is not an object`, filePath);
  }
  const entry = raw as Record<string, unknown>;

  const id = assertString(entry.id, 'id', filePath);
  const flow = assertString(entry.flow, 'flow', filePath);
  if (!flow.includes('/')) {
    throw new QuintSpecsLoadError(
      `Quint spec "${id}" has flow "${flow}" which is not fully-qualified (expected "area-id/behavior-id")`,
      filePath,
    );
  }
  const descriptionHash = assertString(entry.description_hash, 'description_hash', filePath);
  const specText = assertString(entry.spec_text, 'spec_text', filePath);

  const predicatesUsed = Array.isArray(entry.predicates_used)
    ? entry.predicates_used.filter((p): p is string => typeof p === 'string')
    : [];

  const status = entry.status;
  if (typeof status !== 'string' || !VALID_STATUSES.includes(status as QuintSpecStatus)) {
    throw new QuintSpecsLoadError(
      `Quint spec "${id}" has invalid status "${String(status)}" (expected one of ${VALID_STATUSES.join(', ')})`,
      filePath,
    );
  }

  const provenanceRaw = entry.provenance;
  if (!provenanceRaw || typeof provenanceRaw !== 'object') {
    throw new QuintSpecsLoadError(`Quint spec "${id}" is missing "provenance"`, filePath);
  }
  const provenanceObj = provenanceRaw as Record<string, unknown>;
  const draftedBy = assertString(provenanceObj.drafted_by, 'provenance.drafted_by', filePath);
  const draftedAt = assertString(provenanceObj.drafted_at, 'provenance.drafted_at', filePath);
  const provenance: QuintSpecProvenance = {
    drafted_by: draftedBy,
    drafted_at: draftedAt,
    ...(typeof provenanceObj.model === 'string' ? { model: provenanceObj.model } : {}),
    ...(typeof provenanceObj.session_id === 'string' ? { session_id: provenanceObj.session_id } : {}),
  };

  return {
    id,
    flow,
    description_hash: descriptionHash,
    spec_text: specText,
    predicates_used: predicatesUsed,
    status: status as QuintSpecStatus,
    provenance,
  };
}

/**
 * Load specify.quint.yaml. Returns null when the file does not exist (a
 * legitimate "no Quint specs drafted yet" state). THROWS QuintSpecsLoadError on
 * any malformed content — a spec gates test generation, so a broken file must
 * surface loudly rather than masquerade as "zero specs".
 */
export function loadQuintSpecs(filePath: string): QuintSpecsFile | null {
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new QuintSpecsLoadError(`Failed to parse ${filePath} as YAML: ${(err as Error).message}`, filePath, err);
  }

  if (!raw || typeof raw !== 'object') {
    throw new QuintSpecsLoadError(`${filePath} must contain a YAML object`, filePath);
  }
  const data = raw as Record<string, unknown>;

  if (data.version !== 1) {
    throw new QuintSpecsLoadError(`${filePath} has unsupported version "${String(data.version)}" (expected 1)`, filePath);
  }
  if (!Array.isArray(data.specs)) {
    throw new QuintSpecsLoadError(`${filePath} is missing a "specs" array`, filePath);
  }

  const specs = data.specs.map((entry, i) => validateEntry(entry, i, filePath));
  return { version: 1, specs };
}

/** Save specify.quint.yaml atomically (tmp + rename) with a stable field order. */
export function saveQuintSpecs(filePath: string, file: QuintSpecsFile): void {
  const orderedFile = {
    version: file.version,
    specs: file.specs.map((entry) => orderEntry(entry)),
  };
  const body = yaml.dump(orderedFile, { sortKeys: false, lineWidth: 120 });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function orderEntry(entry: QuintSpecEntry): Record<string, unknown> {
  return {
    id: entry.id,
    flow: entry.flow,
    description_hash: entry.description_hash,
    spec_text: entry.spec_text,
    predicates_used: entry.predicates_used,
    status: entry.status,
    provenance: {
      drafted_by: entry.provenance.drafted_by,
      ...(entry.provenance.model !== undefined ? { model: entry.provenance.model } : {}),
      ...(entry.provenance.session_id !== undefined ? { session_id: entry.provenance.session_id } : {}),
      drafted_at: entry.provenance.drafted_at,
    },
  };
}

/** Find all specs for a given fully-qualified flow id. */
export function findQuintSpecs(file: QuintSpecsFile, flowFqId: string): QuintSpecEntry[] {
  return file.specs.filter((s) => s.flow === flowFqId);
}

/** Only the approved specs — the ONLY ones a caller is allowed to simulate/bridge. */
export function approvedQuintSpecs(file: QuintSpecsFile): QuintSpecEntry[] {
  return file.specs.filter((s) => s.status === 'approved');
}

/**
 * Add a draft spec, deduping on (flow, spec_text): a structurally identical
 * spec for the same flow returns the file unchanged (existing entry is
 * authoritative). Otherwise appends a new draft.
 */
export function addQuintDraft(
  file: QuintSpecsFile,
  entry: {
    flow: string;
    spec_text: string;
    description_hash: string;
    predicates_used: string[];
    provenance: QuintSpecProvenance;
  },
): { file: QuintSpecsFile; entry: QuintSpecEntry; deduped: boolean } {
  const existing = file.specs.find((s) => s.flow === entry.flow && s.spec_text === entry.spec_text);
  if (existing) {
    return { file, entry: existing, deduped: true };
  }

  const newEntry: QuintSpecEntry = {
    id: quintSpecId(entry.flow, entry.spec_text),
    flow: entry.flow,
    description_hash: entry.description_hash,
    spec_text: entry.spec_text,
    predicates_used: entry.predicates_used,
    status: 'draft',
    provenance: entry.provenance,
  };

  return {
    file: { ...file, specs: [...file.specs, newEntry] },
    entry: newEntry,
    deduped: false,
  };
}

/** Update the status of a spec by id. Throws if no spec has that id. */
export function setQuintSpecStatus(file: QuintSpecsFile, id: string, status: QuintSpecStatus): QuintSpecsFile {
  const idx = file.specs.findIndex((s) => s.id === id);
  if (idx === -1) {
    throw new Error(`No Quint spec with id "${id}"`);
  }
  const specs = file.specs.slice();
  specs[idx] = { ...specs[idx], status };
  return { ...file, specs };
}

/** Empty file skeleton. */
export function emptyQuintSpecsFile(): QuintSpecsFile {
  return { version: 1, specs: [] };
}
