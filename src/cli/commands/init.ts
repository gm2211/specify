import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../../formal/config.js';
import { agentsBody, installAgentsRegion } from '../../init/agents.js';
import { installPrePushHook, installStopHook } from '../../init/hooks.js';
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
    - Formal: none (pure input/output, covered by tests)
    - Verify: test <name of the conformance test>

\`specify.json\` sets the gate policy (\`strict\` or \`warn\`) and the test reports to read.
\`specify.lock\` records every link; update it with \`specify lock\` and commit it.
Run \`specify gate\` from the project root.
`;

export function init(options: InitOptions, ctx: CliContext): number {
  const root = path.resolve(options.root ?? '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }

  const hadSpecs = fs.existsSync(path.join(root, 'openspec'));
  let openspec: 'initialized' | 'existing' | 'skipped' = 'skipped';
  if (!options.skipOpenspec) {
    if (hadSpecs) {
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

  // New projects start strict; a project that already had specs opts in when it is ready.
  const config = path.join(root, CONFIG_FILE);
  const policy = hadSpecs ? 'warn' : 'strict';
  if (!fs.existsSync(config)) {
    fs.writeFileSync(config, `${JSON.stringify({ policy, testReports: [] }, null, 2)}\n`);
  }

  const command = specifyCommand(root);
  const agents = path.resolve(root, options.agents ?? 'AGENTS.md');
  installAgentsRegion(agents, agentsBody(command));

  const tools = (options.tools ?? 'claude').split(',').map((tool) => tool.trim());
  const claude = tools.includes('claude') || tools.includes('all');
  const skill = claude ? installClaudeSkill(root) : undefined;
  const stopHook = claude ? installStopHook(root, command) : undefined;
  const prePush = installPrePushHook(root, command);

  writeOutput(
    {
      root,
      openspec,
      formal: formalDir,
      config,
      agents,
      ...(skill ? { skill } : {}),
      hooks: { ...(stopHook ? { stop: stopHook } : {}), prePush },
      initialized: true,
    },
    ctx,
  );
  return ExitCode.SUCCESS;
}

/** How agents in this project should invoke Specify. */
function specifyCommand(root: string): string {
  if (fs.existsSync(path.join(root, 'specify'))) return './specify';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.dependencies?.specify || pkg.devDependencies?.specify) return 'npx specify';
  } catch {
    // No package.json: assume a global install.
  }
  return 'specify';
}

/** Copy the bundled property-writing skill into .claude/skills, replacing an older copy. */
function installClaudeSkill(root: string): string {
  const source = fileURLToPath(
    new URL('../../../../skills/formal-properties/SKILL.md', import.meta.url),
  );
  const target = path.join(root, '.claude', 'skills', 'specify-formal-properties', 'SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
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
