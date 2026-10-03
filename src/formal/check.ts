import fs from 'node:fs';
import path from 'node:path';
import { loadSpecWithProvenance } from '../spec/parser.js';
import { lintPath } from '../spec/lint.js';
import type {
  FormalCheck,
  FormalCheckSummary,
  FormalOutcome,
  LeanFormalCheck,
  QuintFormalCheck,
} from './types.js';
import { checkLean } from './lean.js';
import { checkQuint } from './quint.js';

export interface CheckFormalOptions {
  spec: string;
  quintBin?: string;
  leanBin?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function checkFormal(options: CheckFormalOptions): Promise<FormalCheckSummary> {
  const lint = lintPath(options.spec);
  if (!lint.valid) {
    throw new Error(
      `Invalid spec: ${lint.errors
        .filter((entry) => entry.severity === 'error')
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join('\n')}`,
    );
  }
  const loaded = loadSpecWithProvenance(options.spec);
  const references: Array<{ behaviorId: string; check: FormalCheck }> = [];
  const unlinkedBehaviorIds: string[] = [];

  for (const area of loaded.spec.areas) {
    for (const behavior of area.behaviors) {
      const behaviorId = `${area.id}/${behavior.id}`;
      if (behavior.formal?.length) {
        for (const check of behavior.formal) references.push({ behaviorId, check });
      } else {
        unlinkedBehaviorIds.push(behaviorId);
      }
    }
  }

  const results: FormalCheckSummary['results'] = [];
  for (const { behaviorId, check } of references) {
    const file = path.resolve(loaded.provenance.rootPath, check.file);
    const outcome = await runReference(check, file, options);
    results.push({ behaviorId, check, outcome });
  }

  return {
    valid: results.length > 0 && results.every(({ outcome }) => outcome.status === 'passed'),
    scope: 'formal-models-only',
    results,
    unlinkedBehaviorIds,
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
      status: 'error',
      evidence: check.tool === 'quint' ? evidenceForQuint(check) : 'proof',
      stdout: '',
      stderr: '',
      durationMs: 0,
      exitCode: null,
      statement: check.property,
      ...(check.tool === 'quint' ? { scope: scopeForQuint(check) } : {}),
      message: `Formal source file not found: ${file}`,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (check.tool === 'quint') {
    return checkQuint(check as QuintFormalCheck, file, {
      executable: options.quintBin ?? 'quint',
      cwd: process.cwd(),
      timeoutMs,
    });
  }
  return checkLean(check as LeanFormalCheck, file, {
    executable: options.leanBin ?? 'lean',
    cwd: process.cwd(),
    timeoutMs,
  });
}

function evidenceForQuint(check: QuintFormalCheck): 'simulation' | 'bounded-model-check' {
  return check.mode === 'simulate' ? 'simulation' : 'bounded-model-check';
}

function scopeForQuint(check: QuintFormalCheck) {
  return {
    mode: check.mode,
    backend: check.mode === 'simulate' ? ('typescript' as const) : ('apalache' as const),
    maxSteps: check.maxSteps,
    ...(check.mode === 'simulate' ? { samples: check.samples, seed: check.seed } : {}),
  };
}
