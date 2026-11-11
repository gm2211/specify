import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STOP_MARKER = 'gate --hook stop';
const PRE_PUSH_MARKER = 'gate --hook pre-push';

interface HookCommand {
  type?: string;
  command?: string;
}
interface HookGroup {
  hooks?: HookCommand[];
}

/**
 * Add a Claude Code Stop hook to `.claude/settings.json` that runs the gate when an agent tries to
 * finish. Exit code 2 sends the report back to the agent. Other settings are preserved, and an
 * existing Specify hook is updated in place.
 */
export function installStopHook(root: string, command: string): string {
  const file = path.join(root, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new Error(`${file} must be a JSON object`);
    }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const entry: HookCommand = {
    type: 'command',
    command: `${command} ${STOP_MARKER} --changed --skip-verify`,
  };
  const existing = stop
    .flatMap((group) => group.hooks ?? [])
    .find((hook) => hook.command?.includes(STOP_MARKER));
  if (existing) existing.command = entry.command;
  else stop.push({ hooks: [entry] });
  settings.hooks = { ...hooks, Stop: stop };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

export type PrePushResult = 'installed' | 'present' | 'skipped-existing-hook' | 'skipped-no-git';

/**
 * Install `.git/hooks/pre-push` when the project has no pre-push hook of its own. A project with
 * `core.hooksPath` or an existing hook keeps it; add the gate command to that hook by hand.
 */
export function installPrePushHook(root: string, command: string): PrePushResult {
  const gitDir = path.join(root, '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return 'skipped-no-git';
  const hooksPath = spawnSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'], {
    encoding: 'utf8',
  }).stdout.trim();
  const hook = path.join(
    hooksPath ? path.resolve(root, hooksPath) : path.join(gitDir, 'hooks'),
    'pre-push',
  );
  if (fs.existsSync(hook)) {
    return fs.readFileSync(hook, 'utf8').includes(PRE_PUSH_MARKER)
      ? 'present'
      : 'skipped-existing-hook';
  }
  if (hooksPath) return 'skipped-existing-hook';
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(
    hook,
    `#!/bin/sh\n# Installed by specify init: run the gate on changed models before pushing.\nexec ${command} ${PRE_PUSH_MARKER} --changed --skip-verify\n`,
    { mode: 0o755 },
  );
  return 'installed';
}
