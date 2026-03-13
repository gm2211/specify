/**
 * src/mcp/tools.ts — MCP tool registrations for Specify
 *
 * Each tool wraps an existing Specify function so there's no duplication.
 * Tools are designed for LLM agents authoring and validating specs.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Core imports — reuse existing Specify modules directly
import { parseSpec, loadSpec, specToYaml } from '../spec/parser.js';
import { lintRaw } from '../spec/lint.js';
import { getAuthoringGuide } from '../spec/guide.js';
import { analyzeInteractive, summarizeSpec } from '../spec/evolve.js';
import { generateTestsFromSpec } from '../e2e/spec-to-test.js';
import { COMMANDS } from '../cli/commands-manifest.js';

export function registerTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_authoring_guide — Everything an LLM needs to write specs
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_authoring_guide',
    {
      title: 'Get Spec Authoring Guide',
      description:
        'Returns the complete Specify spec authoring guide: JSON Schema, annotated examples, ' +
        'patterns for every spec construct, all assertion/step types, and best practices. ' +
        'Call this first when writing a new spec.',
    },
    async () => {
      const guide = getAuthoringGuide();
      return {
        content: [{ type: 'text', text: JSON.stringify(guide, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // lint_spec — Validate spec structure without captures
  // -------------------------------------------------------------------------
  server.registerTool(
    'lint_spec',
    {
      title: 'Lint Spec',
      description:
        'Validate a spec for structural correctness. Checks YAML/JSON syntax, ' +
        'JSON Schema compliance, and semantic rules (duplicate IDs, invalid cross-references, ' +
        'empty steps, undefined variables). No live application or captures needed.',
      inputSchema: {
        content: z.string().describe('The spec content as a YAML or JSON string'),
      },
    },
    async ({ content }) => {
      const result = lintRaw(content);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // analyze_gaps — Find weaknesses in a spec
  // -------------------------------------------------------------------------
  server.registerTool(
    'analyze_gaps',
    {
      title: 'Analyze Spec Gaps',
      description:
        'Analyze a spec for missing coverage: pages without assertions, scenarios without ' +
        'error paths, missing flows, missing defaults/assumptions, CLI commands without output ' +
        'assertions. Returns structured suggestions with proposed changes and questions to ask the user.',
      inputSchema: {
        content: z.string().describe('The spec content as a YAML or JSON string'),
      },
    },
    async ({ content }) => {
      try {
        const spec = parseSpec(content);
        const summary = summarizeSpec(spec);
        const suggestions = analyzeInteractive(spec);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ spec_summary: summary, suggestions }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // validate_spec — Full validation against captures (file-based)
  // -------------------------------------------------------------------------
  server.registerTool(
    'validate_spec',
    {
      title: 'Validate Spec Against Captures',
      description:
        'Run full validation of a spec file against captured data. Requires file paths ' +
        'on disk. For structural-only validation, use lint_spec instead.',
      inputSchema: {
        spec_path: z.string().describe('Path to the spec file on disk'),
        capture_path: z.string().describe('Path to the capture directory on disk'),
      },
    },
    async ({ spec_path, capture_path }) => {
      try {
        // Dynamic import to avoid loading validation code unless needed
        const { specValidate } = await import('../cli/commands/spec-validate.js');

        // Capture stdout by running the command
        const output: string[] = [];
        const origWrite = process.stdout.write;
        process.stdout.write = ((chunk: string | Uint8Array) => {
          output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
          return true;
        }) as typeof process.stdout.write;

        const exitCode = await specValidate(
          { spec: spec_path, capture: capture_path },
          { outputFormat: 'json', quiet: true },
        );

        process.stdout.write = origWrite;

        return {
          content: [{
            type: 'text',
            text: output.join('') || JSON.stringify({ exit_code: exitCode }),
          }],
          isError: exitCode !== 0,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // export_tests — Generate test code from a spec
  // -------------------------------------------------------------------------
  server.registerTool(
    'export_tests',
    {
      title: 'Export Tests',
      description:
        'Generate Playwright or Cypress test code from a spec. Returns generated test files ' +
        'with file paths and content. Useful for turning specs into runnable e2e tests.',
      inputSchema: {
        content: z.string().describe('The spec content as a YAML or JSON string'),
        framework: z.enum(['playwright', 'cypress']).describe('Target test framework'),
      },
    },
    async ({ content, framework }) => {
      try {
        const spec = parseSpec(content);
        const files = generateTestsFromSpec(spec, { framework });
        return {
          content: [{ type: 'text', text: JSON.stringify(files, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // get_spec_summary — Quick summary of what a spec covers
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_spec_summary',
    {
      title: 'Get Spec Summary',
      description:
        'Parse a spec and return a concise summary: page count, flow count, scenario count, ' +
        'CLI command count, whether defaults/assumptions/hooks are set.',
      inputSchema: {
        content: z.string().describe('The spec content as a YAML or JSON string'),
      },
    },
    async ({ content }) => {
      try {
        const spec = parseSpec(content);
        const summary = summarizeSpec(spec);
        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // list_commands — Show all available CLI commands
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_commands',
    {
      title: 'List CLI Commands',
      description:
        'Returns the full manifest of all Specify CLI commands with their parameters, ' +
        'types, and descriptions. Useful for discovering what Specify can do.',
    },
    async () => {
      return {
        content: [{ type: 'text', text: JSON.stringify(COMMANDS, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // parse_spec — Parse and return structured spec from YAML/JSON
  // -------------------------------------------------------------------------
  server.registerTool(
    'parse_spec',
    {
      title: 'Parse Spec',
      description:
        'Parse a YAML or JSON spec string into a structured object. Returns the parsed spec ' +
        'or validation errors. Useful for programmatically inspecting spec contents.',
      inputSchema: {
        content: z.string().describe('The spec content as a YAML or JSON string'),
      },
    },
    async ({ content }) => {
      try {
        const spec = parseSpec(content);
        return {
          content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // spec_to_yaml — Convert a JSON spec object to YAML
  // -------------------------------------------------------------------------
  server.registerTool(
    'spec_to_yaml',
    {
      title: 'Spec to YAML',
      description:
        'Convert a spec from JSON to well-formatted YAML. Useful when you\'ve built ' +
        'a spec programmatically and want the canonical YAML output.',
      inputSchema: {
        content: z.string().describe('The spec as a JSON string'),
      },
    },
    async ({ content }) => {
      try {
        const spec = parseSpec(content);
        const yamlStr = specToYaml(spec);
        return {
          content: [{ type: 'text', text: yamlStr }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );
}
