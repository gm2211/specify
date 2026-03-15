/**
 * src/cli/commands/bootstrap.ts — Set up specify-driven development workflow
 *
 * Writes:
 *   1. CLAUDE.md section with specify-driven development instructions
 *   2. Git pre-commit hook that runs `specify lint` + `specify verify cli`
 *
 * Idempotent — safe to run multiple times.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';

export interface BootstrapOptions {
  dryRun: boolean;
  targetDir: string;
  spec?: string;
}

interface BootstrapAction {
  type: 'create' | 'update' | 'skip';
  path: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Content templates
// ---------------------------------------------------------------------------

const CLAUDE_MD_MARKER = '<!-- specify-bootstrap -->';

function claudeMdSection(specPath?: string): string {
  const specFlag = specPath ? ` --spec ${specPath}` : '';
  return `
${CLAUDE_MD_MARKER}
## Specify-Driven Development

Every behavior change MUST follow this workflow:

### 1. Evolve — reason through the contract change

Before writing code, decide how the contract should change.

- Consider the task, feature request, PR, or bug in context of the current spec.
- Run \`specify evolve${specFlag}\` for structural signals and gap analysis.
- Use your own judgment — evolve provides signals, you make the decisions.

### 2. Write assertions first (RED)

Update the spec file with new or changed assertions that reflect the intended behavior.
These assertions should FAIL against the current implementation — that's the point.

### 3. Implement the change (GREEN)

Write the code to make the failing assertions pass.

### 4. Verify

- \`specify lint${specFlag}\` — check contract structure is valid
- \`specify verify cli${specFlag}\` — confirm all assertions pass

### 5. Commit spec + code together

The contract and implementation travel as one unit. Never commit code without updating the spec, and never update the spec without verifying the implementation.

### Rules for agents
- Never skip the evolve step. Even for "obvious" changes, think through what the contract should say.
- If \`specify verify cli\` fails, fix the code — not the spec (unless the spec is genuinely wrong).
- \`lint\` computes facts. \`evolve\` guides thinking. Don't confuse them.
${CLAUDE_MD_MARKER}
`.trimStart();
}

function preCommitHook(specPath?: string): string {
  const specFlag = specPath ? ` --spec ${specPath}` : '';
  return `#!/bin/sh
# specify-bootstrap: pre-commit hook
# Runs specify lint and verify cli before allowing commits

# Find the specify binary
SPECIFY="./specify"
if ! [ -x "$SPECIFY" ]; then
  SPECIFY="$(command -v specify 2>/dev/null || true)"
fi

if [ -z "$SPECIFY" ]; then
  echo "⚠ specify not found, skipping pre-commit checks"
  exit 0
fi

echo "Running specify lint..."
$SPECIFY lint${specFlag} --quiet
LINT_EXIT=$?
if [ $LINT_EXIT -ne 0 ]; then
  echo "✗ specify lint failed (exit $LINT_EXIT)"
  exit 1
fi

echo "Running specify verify cli..."
$SPECIFY verify cli${specFlag} --quiet
VERIFY_EXIT=$?
if [ $VERIFY_EXIT -ne 0 ]; then
  echo "✗ specify verify cli failed (exit $VERIFY_EXIT)"
  exit 1
fi

echo "✓ specify checks passed"
`;
}

function prePushHook(): string {
  return `#!/bin/sh
# specify-bootstrap: pre-push hook
# Bumps patch version in package.json before pushing

PACKAGE_JSON="package.json"
if ! [ -f "$PACKAGE_JSON" ]; then
  exit 0
fi

# Read current version
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null)
if [ -z "$CURRENT_VERSION" ]; then
  exit 0
fi

# Bump patch version
NEW_VERSION=$(node -e "
  const parts = '$CURRENT_VERSION'.split('.');
  parts[2] = parseInt(parts[2] || 0) + 1;
  console.log(parts.join('.'));
")

# Update package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\\n');
"

git add "$PACKAGE_JSON"
git commit --amend --no-edit --no-verify

echo "✓ Version bumped: $CURRENT_VERSION → $NEW_VERSION"
`;
}

// ---------------------------------------------------------------------------
// Bootstrap logic
// ---------------------------------------------------------------------------

function planActions(targetDir: string, specPath?: string): BootstrapAction[] {
  const actions: BootstrapAction[] = [];

  // 1. CLAUDE.md
  const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    if (content.includes(CLAUDE_MD_MARKER)) {
      actions.push({ type: 'skip', path: claudeMdPath, description: 'CLAUDE.md already has specify section' });
    } else {
      actions.push({ type: 'update', path: claudeMdPath, description: 'Append specify-driven development section to CLAUDE.md' });
    }
  } else {
    actions.push({ type: 'create', path: claudeMdPath, description: 'Create CLAUDE.md with specify-driven development instructions' });
  }

  // 2. Git pre-commit hook
  const gitHooksDir = path.join(targetDir, '.git', 'hooks');
  const preCommitPath = path.join(gitHooksDir, 'pre-commit');

  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    // No .git directory — still plan the hook but note it
    actions.push({ type: 'skip', path: preCommitPath, description: 'No .git directory found — skipping pre-commit hook' });
  } else if (fs.existsSync(preCommitPath)) {
    const content = fs.readFileSync(preCommitPath, 'utf-8');
    if (content.includes('specify-bootstrap')) {
      actions.push({ type: 'skip', path: preCommitPath, description: 'Pre-commit hook already has specify checks' });
    } else {
      // Existing hook not managed by us — don't overwrite
      actions.push({ type: 'skip', path: preCommitPath, description: 'Pre-commit hook exists (not managed by specify) — skipping' });
    }
  } else {
    actions.push({ type: 'create', path: preCommitPath, description: 'Create pre-commit hook with specify lint + verify cli' });
  }

  // 3. Git pre-push hook (semver bump)
  const prePushPath = path.join(gitHooksDir, 'pre-push');

  if (!fs.existsSync(path.join(targetDir, '.git'))) {
    actions.push({ type: 'skip', path: prePushPath, description: 'No .git directory found — skipping pre-push hook' });
  } else if (fs.existsSync(prePushPath)) {
    const content = fs.readFileSync(prePushPath, 'utf-8');
    if (content.includes('specify-bootstrap')) {
      actions.push({ type: 'skip', path: prePushPath, description: 'Pre-push hook already has version bump' });
    } else {
      actions.push({ type: 'skip', path: prePushPath, description: 'Pre-push hook exists (not managed by specify) — skipping' });
    }
  } else {
    actions.push({ type: 'create', path: prePushPath, description: 'Create pre-push hook for semver patch bump on push' });
  }

  return actions;
}

function executeActions(actions: BootstrapAction[], targetDir: string, specPath?: string): void {
  for (const action of actions) {
    if (action.type === 'skip') continue;

    if (action.path.endsWith('CLAUDE.md')) {
      const section = claudeMdSection(specPath);
      if (action.type === 'create') {
        fs.writeFileSync(action.path, section);
      } else {
        // append
        const existing = fs.readFileSync(action.path, 'utf-8');
        fs.writeFileSync(action.path, existing.trimEnd() + '\n\n' + section);
      }
    } else if (action.path.includes('pre-commit')) {
      const hook = preCommitHook(specPath);
      const dir = path.dirname(action.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(action.path, hook, { mode: 0o755 });
    } else if (action.path.includes('pre-push')) {
      const hook = prePushHook();
      const dir = path.dirname(action.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(action.path, hook, { mode: 0o755 });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function bootstrap(options: BootstrapOptions, ctx: CliContext): Promise<number> {
  const targetDir = path.resolve(options.targetDir);

  // Ensure target directory exists
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const actions = planActions(targetDir, options.spec);

  if (!options.dryRun) {
    executeActions(actions, targetDir, options.spec);
  }

  const result = {
    dry_run: options.dryRun,
    target_dir: targetDir,
    actions: actions.map(a => ({
      type: a.type,
      path: a.path,
      description: a.description,
    })),
  };

  if (ctx.outputFormat === 'json' || !process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stderr.write(`${options.dryRun ? 'Would perform' : 'Performed'} ${actions.length} action(s):\n`);
    for (const a of actions) {
      const icon = a.type === 'skip' ? '○' : a.type === 'create' ? '+' : '~';
      process.stderr.write(`  ${icon} ${a.description}\n`);
      process.stderr.write(`    ${a.path}\n`);
    }
  }

  return ExitCode.SUCCESS;
}
