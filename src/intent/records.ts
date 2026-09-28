import { mkdir, open, readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const nonblank = z.string().refine((value) => value.trim().length > 0, 'must be nonblank');
const MAX_RECORD_BYTES = 16 * 1024;

function isKebabCase(value: string): boolean {
  return value
    .split('-')
    .every((part) => part.length > 0 && [...part].every((character) => isLowerAlphaNum(character)));
}

function isLowerAlphaNum(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function isBehaviorId(value: string): boolean {
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => isKebabCase(part));
}

function validScopePath(value: string): boolean {
  if (
    value.startsWith('/') ||
    /^[a-z]:/i.test(value) ||
    value.includes('\\') ||
    value.includes('\0')
  )
    return false;
  const body = value.endsWith('/') ? value.slice(0, -1) : value;
  if (body.length === 0) return false;
  return body.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export const IntentRecordSchema = z
  .object({
    id: z.string().refine(isKebabCase, 'must be kebab-case'),
    statement: nonblank.max(2_000, 'must be at most 2000 characters; split focused intents'),
    kind: z.enum(['decision', 'assumption', 'proposal']),
    source: z
      .object({
        text: nonblank.max(8_000, 'must be at most 8000 characters; preserve concise exact source'),
        reference: nonblank.optional(),
      })
      .strict(),
    rationale: nonblank.optional(),
    appliesTo: z.array(
      z.string().refine(validScopePath, 'must be repo-relative path or directory prefix'),
    ),
    behaviorIds: z
      .array(z.string().refine(isBehaviorId, 'must be fully-qualified area/behavior ID'))
      .optional(),
    supersedes: z.array(z.string().refine(isKebabCase, 'must be kebab-case')).optional(),
  })
  .strict();

export type IntentRecord = z.infer<typeof IntentRecordSchema>;

function recordsDir(packPath: string): string {
  return path.join(path.resolve(packPath), 'records');
}

async function ensureRecordsDir(packPath: string, create: boolean): Promise<string> {
  const root = path.resolve(packPath);
  const dir = recordsDir(root);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error(`Unsafe intent pack directory: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return dir;
    await mkdir(root, { recursive: true });
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new Error(`Unsafe intent pack directory: ${root}`);
  }
  if (create) await mkdir(dir, { recursive: true });
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Unsafe records directory: ${dir}`);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return dir;
    throw error;
  }
  return dir;
}

function parseRecord(value: unknown, sourcePath: string): IntentRecord {
  const parsed = IntentRecordSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Invalid intent record ${sourcePath}: ${parsed.error.message}`);
  const record = parsed.data;
  const bytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (bytes > MAX_RECORD_BYTES)
    throw new Error(
      `Intent record ${sourcePath} exceeds ${MAX_RECORD_BYTES} bytes; split focused intents`,
    );
  return record;
}

function validateRelations(records: IntentRecord[]): void {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    for (const id of record.supersedes ?? []) {
      if (!byId.has(id))
        throw new Error(`Intent record ${record.id} supersedes missing record ${id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Cyclic intent supersession involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of byId.get(id)?.supersedes ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const record of records) visit(record.id);
}

/** Create one immutable-by-convention JSON record. Existing IDs are never overwritten. */
export async function captureIntent(
  packPath: string,
  input: unknown,
): Promise<{ path: string; record: IntentRecord }> {
  const record = parseRecord(input, 'input');
  const existing = await loadIntentRecords(packPath);
  if (existing.some((item) => item.id === record.id))
    throw Object.assign(new Error(`Intent record already exists: ${record.id}`), {
      code: 'EEXIST',
    });
  validateRelations([...existing, record]);
  const dir = await ensureRecordsDir(packPath, true);
  const filePath = path.join(dir, `${record.id}.json`);
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return { path: filePath, record };
}

/** Load and validate every JSON record, including cross-record supersession links. */
export async function loadIntentRecords(packPath: string): Promise<IntentRecord[]> {
  const dir = await ensureRecordsDir(packPath, false);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names = entries.map((entry) => entry.name).sort();
  const records: IntentRecord[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.json') || !isKebabCase(name.slice(0, -5)))
      throw new Error(`Malformed intent record filename: ${name}`);
    const filePath = path.join(dir, name);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`Unsafe intent record file: ${name}`);
    const record = parseRecord(JSON.parse(await readFile(filePath, 'utf8')) as unknown, name);
    if (`${record.id}.json` !== name)
      throw new Error(`Intent record filename/id mismatch: ${name}`);
    if (seen.has(record.id)) throw new Error(`Duplicate intent record ID: ${record.id}`);
    seen.add(record.id);
    records.push(record);
  }
  validateRelations(records);
  return records;
}

export interface IntentContextOptions {
  query?: string;
  paths?: string[];
}

export interface IntentContext {
  records: IntentRecord[];
  total: number;
  omitted: number;
  query?: string;
  paths?: string[];
}

/** Return relevant durable intent. Global decisions remain visible under all filters. */
export async function getIntentContext(
  packPath: string,
  options: IntentContextOptions = {},
): Promise<IntentContext> {
  const all = await loadIntentRecords(packPath);
  const active = all.filter(
    (record) =>
      !all.some(
        (successor) => successor.kind === 'decision' && successor.supersedes?.includes(record.id),
      ),
  );
  const query = options.query?.trim();
  const terms = query?.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const paths = options.paths;
  for (const candidate of paths ?? []) {
    if (!validScopePath(candidate)) throw new Error(`Invalid intent context path: ${candidate}`);
  }
  const records = active.filter((record) => {
    const globalDecision = record.kind === 'decision' && record.appliesTo.length === 0;
    if (globalDecision) return true;
    const pathMatch =
      !paths?.length ||
      record.appliesTo.length === 0 ||
      record.appliesTo.some((scope) =>
        paths.some((candidate) => {
          const scopePath = scope.endsWith('/') ? scope : `${scope}/`;
          const candidatePath = candidate.endsWith('/') ? candidate : `${candidate}/`;
          return scope.endsWith('/')
            ? candidate === scope.slice(0, -1) ||
                candidate.startsWith(scope) ||
                scope.startsWith(candidatePath)
            : candidate === scope ||
                candidate.startsWith(scopePath) ||
                scope.startsWith(candidatePath);
        }),
      );
    const searchable =
      `${record.id}\n${record.statement}\n${record.rationale ?? ''}\n${record.source.text}\n${record.behaviorIds?.join(' ') ?? ''}`.toLocaleLowerCase();
    const queryMatch = terms.every((term) => searchable.includes(term));
    if (paths?.length && terms.length) return pathMatch || queryMatch;
    return pathMatch && queryMatch;
  });
  return {
    records,
    total: records.length,
    omitted: active.length - records.length,
    ...(query ? { query } : {}),
    ...(paths ? { paths } : {}),
  };
}
