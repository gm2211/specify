/**
 * src/cli/commands/spec-context.ts — Generate/refresh PRODUCT.md and DESIGN.md
 * from the composed spec.
 *
 * Pure projection, no LLM call: the spec's own area prose and behavior
 * descriptions ARE the product doctrine. DESIGN.md additionally pulls in an
 * optional, clearly-separated pass that extracts real visual tokens from
 * code (never invented). Regeneration is non-destructive — see
 * src/spec/managed-regions.ts for the managed-region / proposed-file
 * mechanism.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadSpecWithProvenance } from '../../spec/parser.js';
import {
  buildProductContext,
  buildDesignContext,
  renderProductMarkdown,
  renderDesignMarkdown,
} from '../../spec/product-context.js';
import { extractDesignTokens } from '../../spec/design-tokens.js';
import { writeManagedFile, type WriteManagedFileResult } from '../../spec/managed-regions.js';
import { ExitCode } from '../exit-codes.js';
import type { CliContext } from '../types.js';
import { c } from '../colors.js';

export interface SpecContextOptions {
  spec: string;
  outDir?: string;
  product?: string;
  design?: string;
  force?: boolean;
}

const PRODUCT_REGION_ID = 'product-context';
const DESIGN_REGION_ID = 'design-context';

export async function specContext(options: SpecContextOptions, ctx: CliContext): Promise<number> {
  if (!options.spec) {
    process.stderr.write('Missing --spec (and none could be auto-discovered)\n');
    return ExitCode.PARSE_ERROR;
  }

  const specPath = path.resolve(options.spec);
  if (!fs.existsSync(specPath)) {
    process.stderr.write(`Spec source not found: ${specPath}\n`);
    return ExitCode.PARSE_ERROR;
  }

  let loaded;
  try {
    loaded = loadSpecWithProvenance(specPath);
  } catch (err) {
    process.stderr.write(`Failed to load spec: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const { spec } = loaded;
  const outDir = path.resolve(options.outDir || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const productPath = path.resolve(outDir, options.product || 'PRODUCT.md');
  const designPath = path.resolve(outDir, options.design || 'DESIGN.md');

  const specSourceLabel = path.relative(process.cwd(), specPath) || specPath;
  // Token extraction scans the directory that CONTAINS the spec source, not the spec
  // directory itself: by convention a directory spec (e.g. `specify.spec/`, `spec/`) sits
  // directly at the project root, same as a single spec.yaml file would, so its parent is
  // the codebase root worth scanning for design-token files.
  const tokenScanRoot = path.dirname(specPath);

  const productContext = buildProductContext(spec);
  const tokenExtraction = extractDesignTokens(tokenScanRoot);
  const designContext = buildDesignContext(spec, tokenExtraction);

  const productBody = renderProductMarkdown(productContext, specSourceLabel);
  const designBody = renderDesignMarkdown(designContext, specSourceLabel);

  const productResult = writeManagedFile({
    targetPath: productPath,
    regionId: PRODUCT_REGION_ID,
    header: `# Product: ${spec.name}`,
    body: productBody,
    force: options.force,
  });
  const designResult = writeManagedFile({
    targetPath: designPath,
    regionId: DESIGN_REGION_ID,
    header: `# Design: ${spec.name}`,
    body: designBody,
    force: options.force,
  });

  if (ctx.outputFormat === 'json' || ctx.outputFormat === 'ndjson') {
    process.stdout.write(JSON.stringify({
      spec: { name: spec.name, version: spec.version, source: specSourceLabel },
      product: productContext,
      design: designContext,
      files: {
        product: productResult,
        design: designResult,
      },
    }, null, 2) + '\n');
  }

  if (!ctx.quiet) {
    reportFile('PRODUCT.md', productResult);
    reportFile('DESIGN.md', designResult);
  }

  // Both file operations always succeed as file I/O (creation, merge, force-overwrite, or
  // proposal write) — a refused-and-proposed outcome is the intended safe path, not an
  // error, so the command still exits 0. Callers that need to know whether every target
  // was actually applied in place should check the JSON `files.*.applied` fields.
  return ExitCode.SUCCESS;
}

function reportFile(label: string, result: WriteManagedFileResult): void {
  if (result.applied) {
    const verb = result.created ? 'created' : result.forced ? 'overwritten (--force)' : 'updated (managed region)';
    process.stderr.write(`${c.boldGreen('✓')} ${label} ${verb}: ${result.path}\n`);
  } else {
    process.stderr.write(`${c.yellow('⚠')} ${label} has unmanaged content (no specify:begin/end markers found) — refusing to overwrite in place.\n`);
    process.stderr.write(`  ${c.dim('Proposal written to:')} ${result.proposedPath}\n`);
    process.stderr.write(`  ${c.dim('Review the diff and merge by hand, add the markers yourself, or re-run with --force to overwrite.')}\n`);
  }
}
