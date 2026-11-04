import fs from 'node:fs';
import path from 'node:path';
import { checkLean } from './lean.js';
import { scanOpenSpec } from './openspec.js';
import { checkQuint, evidenceForQuint, scopeForQuint } from './quint.js';
import type { FormalCheck, FormalCheckResult, FormalCheckSummary, FormalOutcome } from './types.js';

export interface CheckFormalOptions {
  /** Project root: the directory containing `openspec/`. */
  root: string;
  quintBin?: string;
  leanBin?: string;
  timeoutMs?: number;
  /** Run only links for this tool. */
  tool?: 'quint' | 'lean';
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function checkFormal(options: CheckFormalOptions): Promise<FormalCheckSummary> {
  const root = path.resolve(options.root);
  const scan = scanOpenSpec(root);
  const linked = new Set(scan.references.map((ref) => ref.requirementId));

  const results: FormalCheckResult[] = [];
  for (const ref of scan.references) {
    if (options.tool && ref.check && ref.check.tool !== options.tool) continue;
    if (!ref.check) {
      results.push({
        requirementId: ref.requirementId,
        source: ref.source,
        outcome: errorOutcome('proof', `Invalid Formal line: ${ref.error ?? 'unparsed'}`),
        ok: false,
      });
      continue;
    }
    const outcome = await runReference(ref.check, path.resolve(root, ref.check.file), options);
    results.push({
      requirementId: ref.requirementId,
      source: ref.source,
      check: ref.check,
      outcome,
      ok: outcome.status === ref.check.expect,
    });
  }

  const ok = results.filter((result) => result.ok).length;
  return {
    valid: results.length > 0 && ok === results.length,
    scope: 'formal-models-only',
    root,
    results,
    unlinkedRequirementIds: scan.requirementIds.filter((id) => !linked.has(id)),
    totals: { checks: results.length, ok, notOk: results.length - ok },
  };
}

function errorOutcome(evidence: FormalOutcome['evidence'], message: string): FormalOutcome {
  return {
    status: 'error',
    evidence,
    stdout: '',
    stderr: '',
    durationMs: 0,
    exitCode: null,
    message,
  };
}

async function runReference(
  check: FormalCheck,
  file: string,
  options: CheckFormalOptions,
): Promise<FormalOutcome> {
  let isFile = false;
  try {
    isFile = fs.statSync(file).isFile();
  } catch {
    // Missing and unreadable source files are reported as a structured check error.
  }
  if (!isFile) {
    return {
      ...errorOutcome(
        check.tool === 'quint' ? evidenceForQuint(check) : 'proof',
        `Formal source file not found: ${file}`,
      ),
      statement: check.property,
      ...(check.tool === 'quint' ? { scope: scopeForQuint(check) } : {}),
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = path.resolve(options.root);
  if (check.tool === 'quint') {
    return checkQuint(check, file, { executable: options.quintBin ?? 'quint', cwd, timeoutMs });
  }
  return checkLean(check, file, { executable: options.leanBin ?? 'lean', cwd, timeoutMs });
}
