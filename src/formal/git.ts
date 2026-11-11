import { spawnSync } from 'node:child_process';

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function lines(output: string | undefined): string[] {
  return (output ?? '').split('\n').filter(Boolean);
}

/**
 * Files that differ from `base` (default HEAD), plus untracked files, as paths relative to the
 * root. `undefined` when the root is not in a git work tree.
 */
export function changedFiles(root: string, base?: string): Set<string> | undefined {
  if (git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return undefined;
  const files = new Set<string>([
    ...lines(git(root, ['diff', '--name-only', '--relative', 'HEAD'])),
    ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
  ]);
  if (base) {
    const range = git(root, ['diff', '--name-only', '--relative', `${base}...HEAD`]);
    for (const file of lines(range ?? git(root, ['diff', '--name-only', '--relative', base]))) {
      files.add(file);
    }
  }
  return files;
}

/** Contents of a root-relative file at a git ref, or `undefined` when it does not exist there. */
export function fileAtRef(root: string, ref: string, file: string): string | undefined {
  return git(root, ['show', `${ref}:./${file}`]);
}
