/**
 * src/spec/schema.ts — JSON Schema for the behavioral spec format
 *
 * Areas group behaviors; behaviors are plain-language claims.
 * No matchers, no selectors, no step sequences.
 */

export const specSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Specify Spec',
  description: 'Behavioral spec format — describes WHAT should be true, not HOW to verify it.',
  type: 'object',
  required: ['version', 'name', 'target', 'areas'],
  additionalProperties: false,
  properties: {
    version: {
      type: 'string',
      const: '2',
      description: 'Spec format version.',
    },
    name: {
      type: 'string',
      description: 'Human-readable name for this spec.',
    },
    description: {
      type: 'string',
      description: 'What this spec covers.',
    },
    target: {
      description: 'What kind of system this spec describes.',
      oneOf: [
        {
          type: 'object',
          required: ['type', 'url'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'web' },
            url: { type: 'string', description: 'URL of the web application.' },
          },
        },
        {
          type: 'object',
          required: ['type', 'binary'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'cli' },
            binary: { type: 'string', description: 'Binary or command to invoke.' },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Environment variables.',
            },
            timeout_ms: { type: 'number', description: 'Default timeout in milliseconds.' },
          },
        },
        {
          type: 'object',
          required: ['type', 'url'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', const: 'api' },
            url: { type: 'string', description: 'Base URL of the API.' },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Default headers for API requests.',
            },
          },
        },
      ],
    },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Template variables for parameterization.',
    },
    assumptions: {
      type: 'array',
      description: 'Preconditions that must hold for valid testing.',
      items: {
        type: 'object',
        required: ['description'],
        additionalProperties: false,
        properties: {
          description: { type: 'string', description: 'Plain-language precondition.' },
          check: { type: 'string', description: 'Optional shell command to verify.' },
        },
      },
    },
    hooks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        setup: {
          type: 'array',
          items: { $ref: '#/definitions/hookStep' },
        },
        teardown: {
          type: 'array',
          items: { $ref: '#/definitions/hookStep' },
        },
      },
    },
    areas: {
      type: 'array',
      description: 'Behavioral claims grouped by feature area.',
      minItems: 1,
      items: { $ref: '#/definitions/area' },
    },
    narrative_path: {
      type: 'string',
      description: 'Path to companion narrative document (relative to spec file).',
    },
    test_dir: {
      type: 'string',
      description: 'Hint: where to look for existing tests (e.g. "tests/").',
    },
  },
  definitions: {
    hookStep: {
      type: 'object',
      required: ['name', 'run'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Human-readable name.' },
        run: { type: 'string', description: 'Shell command to run.' },
        save_as: { type: 'string', description: 'Save stdout under this variable name.' },
      },
    },
    area: {
      type: 'object',
      required: ['id', 'name', 'behaviors'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Kebab-case identifier.', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
        name: { type: 'string', description: 'Human-readable name.' },
        prose: { type: 'string', description: 'Essay-style narrative for this area.' },
        behaviors: {
          type: 'array',
          description: 'Behavioral claims within this area.',
          minItems: 1,
          items: { $ref: '#/definitions/behavior' },
        },
      },
    },
    behavior: {
      type: 'object',
      required: ['id', 'description'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Kebab-case identifier, unique within area.', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
        description: { type: 'string', description: 'The behavioral claim — what should be true.' },
        details: { type: 'string', description: 'Additional context, edge cases.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for filtering.',
        },
      },
    },
  },
} as const;
