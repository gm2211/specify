import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentsBody, installAgentsRegion } from '../../init/agents.js';
import { writeOutput } from '../output.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';

/** OpenSpec version used when `openspec` is not on PATH. */
export const OPENSPEC_PACKAGE = '@fission-ai/openspec@1.16.0';

export interface InitOptions {
  root?: string;
  agents?: string;
  tools?: string;
  openspecBin?: string;
  skipOpenspec?: boolean;
}

const FORMAL_README = `# Formal models

Quint models and Lean proofs for the requirements in \`openspec/specs/\`.
Link each one from the requirement it encodes, one list item per check:

    - Formal: quint formal/example.qnt someInvariant
    - Formal: quint formal/example.qnt eventuallyDone temporal expect=holds
    - Formal: quint formal/example_before.qnt eventuallyDone temporal expect=fails
    - Formal: lean formal/Example.lean Example.someTheorem

Run \`specify formal check\` from the project root.
`;

export function init(options: InitOptions, ctx: CliContext): number {
  const root = path.resolve(options.root ?? '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }

  let openspec: 'initialized' | 'existing' | 'skipped' = 'skipped';
  if (!options.skipOpenspec) {
    if (fs.existsSync(path.join(root, 'openspec'))) {
      openspec = 'existing';
    } else {
      const failure = runOpenspecInit(root, options);
      if (failure) {
        process.stderr.write(`${failure}\n`);
        return ExitCode.SETUP_FAILED;
      }
      openspec = 'initialized';
    }
  }

  const formalDir = path.join(root, 'formal');
  fs.mkdirSync(formalDir, { recursive: true });
  const readme = path.join(formalDir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, FORMAL_README);

  const agents = path.resolve(root, options.agents ?? 'AGENTS.md');
  const command = fs.existsSync(path.join(root, 'specify')) ? './specify' : 'npx specify';
  installAgentsRegion(agents, agentsBody(command));

  writeOutput({ root, openspec, formal: formalDir, agents, initialized: true }, ctx);
  return ExitCode.SUCCESS;
}

/** Returns an error message, or undefined on success. OpenSpec output goes to stderr. */
function runOpenspecInit(root: string, options: InitOptions): string | undefined {
  const args = ['init', '--tools', options.tools ?? 'claude', '.'];
  const stdio: ['ignore', number, number] = ['ignore', 2, 2];
  const candidates: Array<[string, string[]]> = options.openspecBin
    ? [[options.openspecBin, args]]
    : [
        ['openspec', args],
        ['npx', ['--yes', OPENSPEC_PACKAGE, ...args]],
      ];
  for (const [executable, argv] of candidates) {
    const result = spawnSync(executable, argv, { cwd: root, stdio });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
    if (result.error) return `openspec init failed: ${result.error.message}`;
    if (result.status !== 0) return `openspec init exited with status ${result.status}`;
    return undefined;
  }
  return 'OpenSpec is not installed and npx is unavailable; install @fission-ai/openspec or pass --skip-openspec';
}
