import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { LeanFormalCheck } from '../spec/types.js';
import { runProcess } from './process.js';
import type { FormalOutcome } from './types.js';

const STANDARD_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound']);

function proofProbe(moduleName: string, property: string, marker: string): string {
  return `import Lean
import ${moduleName}
run_elab do
  let name := ${JSON.stringify(property)}.toName
  let info ← Lean.getConstInfo name
  unless info.isTheorem do
    throwError "Specify target is not a theorem"
  let axioms ← Lean.collectAxioms name
  let statement ← Lean.Meta.MetaM.run' (Lean.Meta.ppExpr info.type)
  let certificate := Lean.Json.mkObj [
    ("theorem", Lean.toJson name.toString),
    ("statement", Lean.toJson statement.pretty),
    ("axioms", Lean.toJson (axioms.map Lean.Name.toString))]
  Lean.logInfo m!"${marker}{certificate.compress}"
`;
}

interface Certificate {
  theorem: string;
  statement: string;
  axioms: string[];
}

function readCertificate(stdout: string, marker: string, property: string): Certificate {
  const certificates: unknown[] = [];
  for (const line of stdout.split('\n').filter((value) => value.trim())) {
    // --json diagnostics must be intact. Never infer success from arbitrary text.
    const diagnostic = JSON.parse(line) as { severity?: string; data?: unknown };
    if (diagnostic.severity === 'error') {
      throw new Error('Lean reported an error despite a zero exit code.');
    }
    if (typeof diagnostic.data === 'string' && diagnostic.data.startsWith(marker)) {
      certificates.push(JSON.parse(diagnostic.data.slice(marker.length)));
    }
  }
  if (certificates.length !== 1) {
    throw new Error('Lean did not emit exactly one theorem certificate.');
  }
  const certificate = certificates[0] as Partial<Certificate> | null;
  if (
    !certificate ||
    certificate.theorem !== property ||
    typeof certificate.statement !== 'string' ||
    !certificate.statement.trim() ||
    !Array.isArray(certificate.axioms) ||
    !certificate.axioms.every((axiom) => typeof axiom === 'string' && axiom.length > 0)
  ) {
    throw new Error('Lean emitted an invalid theorem certificate.');
  }
  return certificate as Certificate;
}

/**
 * Elaborates trusted project code, then inspects the public theorem and its
 * transitive axioms. This is not a sandbox or independent kernel replay. The
 * source is copied unchanged; imported dependencies are caller-built artifacts.
 */
export async function checkLean(
  ref: LeanFormalCheck,
  file: string,
  options: { executable: string; cwd: string; timeoutMs: number },
): Promise<FormalOutcome> {
  const started = Date.now();
  const outcome: FormalOutcome = {
    status: 'error',
    evidence: 'proof',
    stdout: '',
    stderr: '',
    durationMs: 0,
    exitCode: null,
  };
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'specify-lean-'));
    const suffix = randomUUID().replaceAll('-', '');
    const moduleName = `SpecifyProof${suffix}`;
    const source = join(directory, `${moduleName}.lean`);
    const wrapper = join(directory, 'SpecifyInspect.lean');
    const marker = `SPECIFY_PROOF_${suffix}:`;
    await copyFile(file, source);
    await writeFile(wrapper, proofProbe(moduleName, ref.property, marker));
    const commands = [
      ['--json', '-R', directory, '-o', join(directory, `${moduleName}.olean`), source],
      ['--json', wrapper],
    ];
    let proofOutput = '';
    for (const args of commands) {
      const remaining = options.timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        outcome.status = 'timeout';
        outcome.message = 'Lean check exceeded its total time limit.';
        return outcome;
      }
      const result = await runProcess(options.executable, args, {
        cwd: options.cwd,
        timeoutMs: remaining,
        env: {
          ...process.env,
          LEAN_PATH: [directory, process.env.LEAN_PATH].filter(Boolean).join(delimiter),
        },
      });
      outcome.stdout += result.stdout;
      outcome.stderr += result.stderr;
      outcome.exitCode = result.exitCode;
      if (result.unavailable || result.timedOut || result.outputLimit || result.exitCode !== 0) {
        outcome.status = result.unavailable
          ? 'unavailable'
          : result.timedOut
            ? 'timeout'
            : result.outputLimit
              ? 'error'
              : 'failed';
        outcome.message = result.outputLimit
          ? 'Lean output exceeded the capture limit; no proof result accepted.'
          : 'Lean could not complete theorem validation.';
        return outcome;
      }
      proofOutput = result.stdout;
    }
    const certificate = readCertificate(proofOutput, marker, ref.property);
    outcome.axioms = certificate.axioms;
    outcome.statement = certificate.statement;
    const extraAxioms = certificate.axioms.filter((axiom) => !STANDARD_AXIOMS.has(axiom));
    outcome.status = extraAxioms.length === 0 ? 'passed' : 'failed';
    outcome.message = extraAxioms.length
      ? `Theorem relies on unaccepted axioms: ${extraAxioms.join(', ')}.`
      : 'Lean accepted the theorem using only standard axioms.';
    return outcome;
  } catch (error) {
    outcome.message = error instanceof Error ? error.message : String(error);
    return outcome;
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
    outcome.durationMs = Date.now() - started;
  }
}
