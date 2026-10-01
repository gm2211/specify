import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lintPath } from '../../spec/lint.js';
import { loadSpecWithProvenance } from '../../spec/parser.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { writeOutput } from '../output.js';

export interface SpecCheckOptions {
  spec: string;
  base: string;
  reason?: string;
}

export interface SpecCheckReport {
  valid: boolean;
  errors: string[];
  specChanged: boolean;
  changedFiles: string[];
  reason?: string;
}

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function changedFiles(root: string, base: string): string[] {
  const files = new Set<string>();
  const diff = git(root, ['diff', '--name-only', '-z', '--no-renames', base, '--']).toString(
    'utf8',
  );
  for (const file of diff.split('\0')) if (file) files.add(file);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString(
    'utf8',
  );
  for (const file of untracked.split('\0')) if (file) files.add(file);
  return [...files].sort();
}

function specSources(specPath: string): Set<string> {
  const loaded = loadSpecWithProvenance(specPath);
  const provenance = loaded.provenance;
  const sources = new Set<string>();
  if (provenance.kind === 'file') {
    sources.add(specPath);
  } else {
    if (provenance.manifestPath) sources.add(provenance.manifestPath);
    for (const source of Object.values(provenance.areaSources)) sources.add(source);
    for (const source of Object.values(provenance.behaviorSources)) sources.add(source);
  }
  return sources;
}

export async function specCheck(options: SpecCheckOptions, ctx: CliContext): Promise<number> {
  let report: SpecCheckReport = { valid: false, errors: [], specChanged: false, changedFiles: [] };
  let code: number = ExitCode.PARSE_ERROR;
  try {
    const root = fs.realpathSync(
      git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim(),
    );
    const specPath = fs.realpathSync(path.resolve(options.spec));
    if (!isInside(root, specPath)) {
      throw new Error('Spec must resolve inside the Git repository');
    }
    const lint = lintPath(specPath);
    if (!lint.valid) {
      throw new Error(lint.errors.map((error) => `${error.path}: ${error.message}`).join('\n'));
    }
    let base: string;
    try {
      base = git(root, ['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`])
        .toString('utf8')
        .trim();
      git(root, ['merge-base', '--is-ancestor', base, 'HEAD']);
    } catch {
      throw new Error(`Base must resolve to a commit that is an ancestor of HEAD: ${options.base}`);
    }
    const files = changedFiles(root, base);
    const sources = new Set(
      [...specSources(specPath)].map((source) =>
        path.relative(root, source).split(path.sep).join('/'),
      ),
    );
    const specChanged = files.some((file) => sources.has(file));
    const reason = options.reason?.trim();
    const errors =
      files.length && !specChanged && !reason
        ? ['Non-spec changes require a nonblank --reason.']
        : [];
    report = {
      valid: errors.length === 0,
      errors,
      specChanged,
      changedFiles: files,
      ...(reason ? { reason } : {}),
    };
    code = report.valid ? ExitCode.SUCCESS : ExitCode.REVIEW_REQUIRED;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  writeOutput(report, ctx);
  return code;
}
