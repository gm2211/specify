import * as fs from 'node:fs';
import * as path from 'node:path';
import { lintPath } from '../../spec/lint.js';
import { mergeManagedRegion, regionMarkers } from '../../spec/managed-regions.js';
import { writeOutput } from '../output.js';
import type { CliContext } from '../types.js';

/** Install instructions only. Specs stay the sole source of product intent. */
export function specInit(options: { spec: string; agents?: string }, ctx: CliContext): number {
  const lint = lintPath(options.spec);
  if (!lint.valid) {
    writeOutput(lint, ctx);
    return 10;
  }
  const target = path.resolve(options.agents ?? 'AGENTS.md');
  // Refuse symlinked instructions, including dangling links; preserve all unrelated text.
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Agent instruction file must not be a symlink');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  let existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  // Replace only the legacy block installed by Specify 0.3; leave its data files untouched.
  const legacy = regionMarkers('intent-workflow');
  if (existing.includes(legacy.begin) || existing.includes(legacy.end)) {
    if (
      existing.split(legacy.begin).length !== 2 ||
      existing.split(legacy.end).length !== 2 ||
      existing.indexOf(legacy.end) < existing.indexOf(legacy.begin)
    ) {
      throw new Error('Malformed legacy intent-workflow markers; repair before initializing');
    }
    existing =
      existing.slice(0, existing.indexOf(legacy.begin)) +
      existing.slice(existing.indexOf(legacy.end) + legacy.end.length);
  }
  const region = 'spec-workflow';
  const { begin, end } = regionMarkers(region);
  const begins = existing.split(begin).length - 1;
  const ends = existing.split(end).length - 1;
  if (
    begins !== ends ||
    begins > 1 ||
    (begins && existing.indexOf(end) < existing.indexOf(begin))
  ) {
    throw new Error('Malformed spec-workflow markers; repair instructions before initializing');
  }
  const spec = path.relative(process.cwd(), path.resolve(options.spec)) || '.';
  const command = fs.existsSync(path.resolve('specify')) ? './specify' : 'specify';
  const quotedSpec = `'${spec.replaceAll("'", "'\\''")}'`;
  const body = `## Maintain specs as you work

Canonical spec: ${JSON.stringify(spec)}. Run commands from ${JSON.stringify(path.relative(path.dirname(target), process.cwd()) || '.')} relative to this file.

- Read relevant spec areas and global constraints before editing. Use \`${command} spec guide\` for structure.
- Record explicit user decisions directly in the spec, even when no code changes. Keep stable behavior IDs; store exact quotations in source.text and a reference when available. Label proposals and assumptions in prose; never promote guesses into requirements.
- Keep one feature per area, short behavior descriptions, and detail in details/prose. Use \`${command} spec split --spec ${quotedSpec}\` for oversized single-file specs.
- Update specs when intent changes. Never rewrite requirements to excuse incomplete implementation. Report unmet requirements in the handoff and issue tracker.
- Before finishing, run \`${command} spec check --spec ${quotedSpec} --base BASE\`. Use the task start commit or PR base. If intent is unchanged, pass \`--reason 'why existing requirements still cover this change'\` instead of making a token spec edit. Include that explanation in the PR.
- Run project tests separately. This check enforces spec lint and a recorded review reason or source change, not semantic correctness or execution proof.
`;
  const content = begins
    ? mergeManagedRegion(existing, region, body).content
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n${begin}\n${body.trim()}\n${end}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  writeOutput({ path: target, spec: path.resolve(options.spec), initialized: true }, ctx);
  return 0;
}
