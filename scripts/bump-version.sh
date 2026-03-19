#!/usr/bin/env bash
# bump-version.sh — Increment the patch version in package.json
# Usage: scripts/bump-version.sh
# Outputs the new version to stdout.

set -euo pipefail

PACKAGE_JSON="$(git rev-parse --show-toplevel)/package.json"

# Read current version
current=$(node -p "require('$PACKAGE_JSON').version")

# Split into major.minor.patch
IFS='.' read -r major minor patch <<< "$current"

# Increment patch
new_patch=$((patch + 1))
new_version="${major}.${minor}.${new_patch}"

# Write back using node to preserve formatting
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON', 'utf8'));
pkg.version = '$new_version';
fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');
"

echo "$new_version"
