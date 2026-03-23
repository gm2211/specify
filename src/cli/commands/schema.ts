import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { specSchema } from '../../spec/schema.js';
import { specSchemaV2 } from '../../spec/schema-v2.js';
import { COMMANDS } from '../commands-manifest.js';

export async function schemaCommand(target: string, ctx: CliContext): Promise<number> {
  let output: unknown;

  switch (target) {
    case 'spec':
      output = { v1: specSchema, v2: specSchemaV2 };
      break;
    case 'report':
      output = getReportSchema();
      break;
    case 'commands':
      output = COMMANDS;
      break;
    default:
      process.stderr.write(`Unknown schema target: ${target}. Use: spec, report, or commands\n`);
      return ExitCode.PARSE_ERROR;
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  return ExitCode.SUCCESS;
}

function getReportSchema(): object {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Specify Gap Report',
    type: 'object',
    required: ['spec', 'capture', 'summary', 'pages', 'flows'],
    properties: {
      spec: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
        },
      },
      capture: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          timestamp: { type: 'string' },
          targetUrl: { type: 'string' },
          totalRequests: { type: 'number' },
        },
      },
      summary: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          passed: { type: 'number' },
          failed: { type: 'number' },
          untested: { type: 'number' },
          coverage: { type: 'number' },
        },
      },
      assumptions: { type: 'array', items: { $ref: '#/$defs/AssumptionResult' } },
      defaults: { type: 'array', items: { $ref: '#/$defs/DefaultResult' } },
      pages: { type: 'array', items: { $ref: '#/$defs/PageResult' } },
      flows: { type: 'array', items: { $ref: '#/$defs/FlowResult' } },
    },
    $defs: {
      AssumptionResult: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'untested'] },
          reason: { type: 'string' },
        },
      },
      DefaultResult: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'untested'] },
          details: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      PageResult: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          path: { type: 'string' },
          visited: { type: 'boolean' },
          requests: { type: 'array' },
          visualAssertions: { type: 'array' },
          consoleExpectations: { type: 'array' },
          scenarios: { type: 'array' },
        },
      },
      FlowResult: {
        type: 'object',
        properties: {
          flowId: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'untested'] },
          steps: { type: 'array' },
        },
      },
    },
  };
}
