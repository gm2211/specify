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
import { COMMANDS } from '../cli/commands-manifest.js';
import { eventBus } from '../agent/event-bus.js';

export function registerTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // get_authoring_guide — Everything an LLM needs to write specs
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_authoring_guide',
    {
      title: 'Get Spec Authoring Guide',
      description:
        'Returns the complete Specify spec authoring guide: JSON Schema, ' +
        'annotated examples, behavioral patterns, and best practices. Call this first when writing a new spec.',
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
        'undefined variables). No live application or captures needed.',
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
  // subscribe_events — Get the SSE endpoint URL for event streaming
  // -------------------------------------------------------------------------
  server.registerTool(
    'subscribe_events',
    {
      title: 'Subscribe to Events',
      description:
        'Returns the SSE endpoint URL for subscribing to real-time Specify events ' +
        '(behavior progress, agent status, errors). Connect to this URL with an ' +
        'EventSource to receive events as they happen.',
      inputSchema: {
        port: z.number().optional().describe('Review server port (default: 3456)'),
      },
    },
    async ({ port }) => {
      const p = port ?? 3456;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sse_url: `http://localhost:${p}/api/events/stream`,
            inject_url: `http://localhost:${p}/api/agent/inject`,
            publish_url: `http://localhost:${p}/api/events/publish`,
          }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // publish_event — Push an event to the Specify event bus
  // -------------------------------------------------------------------------
  server.registerTool(
    'publish_event',
    {
      title: 'Publish Event',
      description:
        'Publish a structured event to the Specify event bus. Other agents and the ' +
        'review UI will receive this event in real-time.',
      inputSchema: {
        type: z.string().describe('Event type (e.g. "external:status", "ci:result")'),
        data: z.string().optional().describe('JSON string of event data'),
      },
    },
    async ({ type, data }) => {
      const parsedData = data ? JSON.parse(data) : {};
      eventBus.send(type, parsedData);
      return {
        content: [{ type: 'text', text: JSON.stringify({ published: true, eventType: type }) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // inject_message — Send a message into a running agent session
  // -------------------------------------------------------------------------
  server.registerTool(
    'inject_message',
    {
      title: 'Inject Message',
      description:
        'Send a message into a running Specify agent session (verify, capture, etc.). ' +
        'The message will be injected as a user turn in the agent conversation. ' +
        'Requires the review server to be running with an active agent session.',
      inputSchema: {
        message: z.string().describe('The message to inject'),
        priority: z.enum(['now', 'next', 'later']).optional().describe('Message priority (default: next)'),
        port: z.number().optional().describe('Review server port (default: 3456)'),
      },
    },
    async ({ message, priority, port }) => {
      const p = port ?? 3456;
      try {
        const resp = await fetch(`http://localhost:${p}/api/agent/inject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, priority: priority ?? 'next' }),
        });
        const result = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(resp.ok ? {} : { isError: true }),
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
