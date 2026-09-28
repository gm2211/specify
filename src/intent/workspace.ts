import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeManagedRegion, regionMarkers } from '../spec/managed-regions.js';

/** Keep the tracked intent pack inside its owning repository. */
export function intentWorkspace(root = process.cwd(), pack = 'specify.intent') {
  const resolvedRoot = fs.realpathSync(root);
  const packPath = path.resolve(resolvedRoot, pack);
  const relative = path.relative(resolvedRoot, packPath);
  if (
    !relative ||
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('.git')
  ) {
    throw new Error('Intent pack must be a directory inside the repository root');
  }
  assertNoSymlinks(resolvedRoot, packPath);
  return { root: resolvedRoot, packPath, reviewPath: path.join(packPath, 'review.json') };
}

export function assertNoSymlinks(root: string, target: string): void {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing symlink in intent workspace: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export function intentInstructions(pack: string, command = 'specify'): string {
  // JSON quoting keeps paths with spaces readable in the instructions; commands below use --pack.
  const option = `--pack '${pack.replaceAll("'", "'\\''")}'`;
  return `## Specify intent workflow

Run commands from the repository root. The tracked intent pack is ${JSON.stringify(pack)}.

1. Before work, run \`${command} intent context ${option} --query "task words" --paths "src/relevant/"\`.
   Read global decisions and applicable intent. No search result is proof that no other constraint applies.
2. Capture durable user instructions immediately, including conversations with no code change:
   \`${command} intent capture ${option} --input -\` accepts a JSON record on stdin.
   Records require id, statement, kind (decision/assumption/proposal), source.text (exact wording),
   and appliesTo (repository-relative files or directory prefixes; [] means global).
   Preserve source.reference when available. Never invent a quotation or promote a proposal or assumption.
   User approval may reference the approved proposal; retain both sources in the wording/reference.
3. Keep records focused. Edit existing records through normal file edits and Git; retain stable IDs.
   Use supersedes only for an explicit replacement decision. Keep superseded records for history.
   Link behaviorIds when an executable contract exists. Keep behavioral contracts organized by area.
   Update intent when intent changes; unchanged behavior needs no artificial spec edit.
4. Before finishing, choose the task's original base commit or PR base SHA and run
   \`${command} intent check ${option} --base BASE\` to discover changed files and missing review.
   Review every changed file against relevant intent. Write a review with summary and files entries
   containing path, intentIds, outcome (preserved/changed/unmet/none), and reason.
   Use none with [] only when no intent applies; explain why. Other outcomes require existing intent IDs.
   \`${command} intent reconcile ${option} --base BASE --input -\` saves the JSON review from stdin.
   Then run \`${command} intent check ${option} --base BASE\`. Rerun reconciliation after further edits.
5. Commit the intent records and review with the change. Handoff names changed intent and remaining gaps.
   Never weaken requirements to match implementation. Record unmet intent honestly; the completion gate fails.

This is process evidence, not proof of semantic fidelity or test execution. Run appropriate tests separately.
Git/CI checks only see files; agents must capture conversation intent themselves. No transcript watcher is installed.
`;
}

/** Append one owned region; never replace unrelated agent instructions or Git hooks. */
export function initializeIntent(root?: string, pack?: string) {
  const workspace = intentWorkspace(root, pack);
  const agentsPath = path.join(workspace.root, 'AGENTS.md');
  assertNoSymlinks(workspace.root, agentsPath);
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const region = 'intent-workflow';
  const { begin, end } = regionMarkers(region);
  const hasBegin = existing.includes(begin);
  const hasEnd = existing.includes(end);
  if (
    hasBegin !== hasEnd ||
    existing.split(begin).length > 2 ||
    existing.split(end).length > 2 ||
    (hasBegin && existing.indexOf(end) < existing.indexOf(begin))
  ) {
    throw new Error(
      'Malformed Specify intent markers in AGENTS.md; repair them before initializing',
    );
  }
  const body = intentInstructions(
    path.relative(workspace.root, workspace.packPath).split(path.sep).join('/'),
    fs.existsSync(path.join(workspace.root, 'specify')) ? './specify' : 'specify',
  );
  const content = hasBegin
    ? mergeManagedRegion(existing, region, body).content
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n${begin}\n${body.trim()}\n${end}\n`;
  assertNoSymlinks(workspace.root, path.join(workspace.packPath, 'records'));
  fs.mkdirSync(path.join(workspace.packPath, 'records'), { recursive: true });
  fs.writeFileSync(agentsPath, content, 'utf8');
  return { ...workspace, agentsPath, initialized: true, instructions: body };
}
