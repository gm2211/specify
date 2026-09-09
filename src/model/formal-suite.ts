import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadFormalManifest, manifestFile, mutateControl } from './formal-manifest.js';
import { verifyQuint } from './quint-verifier.js';
import { spawnQuint, isValidQuintBinary, type QuintExec } from './quint-runner.js';
export const sha256 = (source: string) => crypto.createHash('sha256').update(source).digest('hex');
export interface SuiteOptions {
  manifestPath: string;
  binary: string;
  output: string;
  cwd: string;
  exec?: QuintExec;
}
export async function toolVersion(options: SuiteOptions, expected: string): Promise<string> {
  if (!isValidQuintBinary(options.binary)) throw new Error('Invalid Quint binary');
  const result = await (options.exec ?? spawnQuint)([options.binary, '--version'], {
    cwd: options.cwd,
    timeoutMs: 10_000,
  });
  if (result.code !== 0 || result.spawnError || result.stdout.trim() !== expected)
    throw new Error(`Expected Quint ${expected}; got ${result.stdout} ${result.stderr}`);
  return result.stdout.trim();
}
export async function runFormalSuite(options: SuiteOptions) {
  fs.mkdirSync(options.output, { recursive: true });
  const report: {
    producer: string;
    checkedAt: string;
    pass: boolean;
    scope: string;
    checks: Record<string, unknown>[];
    revision?: string;
    dirty?: boolean;
    quint?: string;
    java?: string;
    apalache?: string;
    tlc?: string;
    manifestSha256?: string;
    error?: string;
  } = {
    producer: 'specify',
    checkedAt: new Date().toISOString(),
    pass: false,
    scope: 'finite models; conditional liveness; no implementation refinement proof',
    checks: [],
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-formal-'));
  const exec = options.exec ?? spawnQuint;
  try {
    const manifest = loadFormalManifest(options.manifestPath);
    report.manifestSha256 = sha256(fs.readFileSync(options.manifestPath, 'utf8'));
    report.quint = await toolVersion(options, manifest.quintVersion);
    report.apalache = manifest.apalacheVersion;
    const revision = await exec(['git', 'rev-parse', 'HEAD'], {
      cwd: options.cwd,
      timeoutMs: 10_000,
    });
    if (revision.code === 0) report.revision = revision.stdout.trim();
    const status = await exec(['git', 'status', '--porcelain'], {
      cwd: options.cwd,
      timeoutMs: 10_000,
    });
    if (status.code === 0) report.dirty = status.stdout.trim() !== '';
    const java = await exec(['java', '-version'], { cwd: options.cwd, timeoutMs: 10_000 });
    report.java = (java.stdout + java.stderr).trim();
    const checks = manifest.models.map((model) => ({
      id: model.id,
      source: model.main,
      text: fs.readFileSync(manifestFile(options.manifestPath, model.file), 'utf8'),
      invariant: model.invariant,
      temporal: model.temporal,
      control: false,
    }));
    for (const control of manifest.controls) {
      const model = manifest.models.find((m) => m.id === control.model)!;
      checks.push({
        id: control.id,
        source: model.main,
        text: mutateControl(
          fs.readFileSync(manifestFile(options.manifestPath, model.file), 'utf8'),
          control.replace,
        ),
        invariant: control.invariant,
        temporal: control.temporal,
        control: true,
      });
    }
    for (const check of checks) {
      const file = path.join(scratch, `${check.id}.qnt`);
      fs.writeFileSync(file, check.text);
      const result = await verifyQuint({
        binary: options.binary,
        specPath: file,
        main: check.source,
        invariant: check.invariant,
        temporal: check.temporal,
        apalacheVersion: manifest.apalacheVersion,
        tlcConfig: manifestFile(options.manifestPath, manifest.tlcConfig),
        timeoutMs: manifest.timeoutMs,
        exec,
      });
      fs.writeFileSync(path.join(options.output, `${check.id}.log`), result.output);
      const pass = result.verdict === (check.control ? 'counterexample' : 'verified');
      if (result.tlc) report.tlc = result.tlc;
      report.checks.push({
        [check.control ? 'control' : 'model']: check.id,
        sha256: sha256(check.text),
        properties: [check.invariant, ...check.temporal],
        pass,
        verdict: result.verdict,
        exitCode: result.exitCode,
        states: result.states,
        argv: result.argv,
        ...(result.error ? { error: result.error } : {}),
      });
    }
    report.pass =
      report.checks.length === checks.length && report.checks.every((c) => c.pass === true);
  } catch (error) {
    report.error = String(error);
  } finally {
    fs.writeFileSync(
      path.join(options.output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return report;
}
