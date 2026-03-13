/**
 * src/spec/schema.ts — JSON Schema for validating spec documents
 *
 * This schema mirrors the TypeScript types in types.ts and is used
 * by the parser (parser.ts) to validate YAML/JSON spec files at runtime.
 */

/** JSON Schema (Draft 7) for the Specify spec format. */
export const specSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Specify Spec',
  description: 'Computational spec format for functional verification of web applications.',
  type: 'object',
  required: ['version', 'name'],
  additionalProperties: false,
  properties: {
    version: {
      type: 'string',
      description: 'Spec format version.',
    },
    name: {
      type: 'string',
      description: 'Human-readable name for this spec.',
    },
    description: {
      type: 'string',
      description: 'Optional description of what this spec covers.',
    },
    pages: {
      type: 'array',
      items: { $ref: '#/$defs/PageSpec' },
    },
    flows: {
      type: 'array',
      items: { $ref: '#/$defs/FlowSpec' },
    },
    cli: { $ref: '#/$defs/CliSpec' },
    hooks: { $ref: '#/$defs/HooksSpec' },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    assumptions: {
      type: 'array',
      items: { $ref: '#/$defs/Assumption' },
      description: 'Preconditions that must hold for this spec to be validly tested.',
    },
    defaults: { $ref: '#/$defs/DefaultProperties' },
  },

  $defs: {
    // -------------------------------------------------------------------
    // PageSpec
    // -------------------------------------------------------------------
    PageSpec: {
      type: 'object',
      required: ['id', 'path'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        path: { type: 'string' },
        title: { type: 'string' },
        visual_assertions: {
          type: 'array',
          items: { $ref: '#/$defs/VisualAssertion' },
        },
        expected_requests: {
          type: 'array',
          items: { $ref: '#/$defs/ExpectedRequest' },
        },
        console_expectations: {
          type: 'array',
          items: { $ref: '#/$defs/ConsoleExpectation' },
        },
        scenarios: {
          type: 'array',
          items: { $ref: '#/$defs/ScenarioSpec' },
        },
      },
    },

    // -------------------------------------------------------------------
    // VisualAssertion (discriminated union on "type")
    // -------------------------------------------------------------------
    VisualAssertion: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: [
            'element_exists',
            'text_contains',
            'text_matches',
            'screenshot_region',
            'element_count',
          ],
        },
        description: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        pattern: { type: 'string' },
        min: { type: 'number' },
        max: { type: 'number' },
        quantifier: { type: 'string', enum: ['always', 'sometimes'] },
        confidence: { type: 'string', enum: ['observed', 'inferred', 'reviewed'] },
      },
      allOf: [
        {
          if: { properties: { type: { const: 'element_exists' } } },
          then: { required: ['selector'] },
        },
        {
          if: { properties: { type: { const: 'text_contains' } } },
          then: { required: ['selector', 'text'] },
        },
        {
          if: { properties: { type: { const: 'text_matches' } } },
          then: { required: ['selector', 'pattern'] },
        },
        {
          if: { properties: { type: { const: 'screenshot_region' } } },
          then: { required: ['selector'] },
        },
        {
          if: { properties: { type: { const: 'element_count' } } },
          then: { required: ['selector'] },
        },
      ],
    },

    // -------------------------------------------------------------------
    // ExpectedRequest
    // -------------------------------------------------------------------
    ExpectedRequest: {
      type: 'object',
      required: ['method', 'url_pattern'],
      additionalProperties: false,
      properties: {
        method: { type: 'string' },
        url_pattern: { type: 'string' },
        description: { type: 'string' },
        request_body: { $ref: '#/$defs/RequestBodySpec' },
        response: { $ref: '#/$defs/ExpectedResponse' },
        quantifier: { type: 'string', enum: ['always', 'sometimes'] },
        confidence: { type: 'string', enum: ['observed', 'inferred', 'reviewed'] },
      },
    },

    RequestBodySpec: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content_type: { type: 'string' },
        body_schema: { $ref: '#/$defs/JsonSchemaInline' },
      },
    },

    ExpectedResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'number' },
        status_in: { type: 'array', items: { type: 'number' } },
        content_type: { type: 'string' },
        body_schema: { $ref: '#/$defs/JsonSchemaInline' },
      },
    },

    // Permissive inline JSON Schema (we don't fully validate nested schemas)
    JsonSchemaInline: {
      type: 'object',
      additionalProperties: true,
    },

    // -------------------------------------------------------------------
    // ConsoleExpectation
    // -------------------------------------------------------------------
    ConsoleExpectation: {
      type: 'object',
      required: ['level'],
      additionalProperties: false,
      properties: {
        level: { type: 'string' },
        count: { type: 'number' },
        exclude_pattern: { type: 'string' },
        quantifier: { type: 'string', enum: ['always', 'sometimes'] },
        confidence: { type: 'string', enum: ['observed', 'inferred', 'reviewed'] },
      },
    },

    // -------------------------------------------------------------------
    // ScenarioSpec
    // -------------------------------------------------------------------
    ScenarioSpec: {
      type: 'object',
      required: ['id', 'steps'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        steps: {
          type: 'array',
          items: { $ref: '#/$defs/ScenarioStep' },
        },
      },
    },

    ScenarioStep: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'click',
            'fill',
            'select',
            'hover',
            'wait_for_request',
            'wait_for_navigation',
            'assert_visible',
            'assert_text',
            'assert_not_visible',
            'keypress',
            'scroll',
            'wait',
          ],
        },
        description: { type: 'string' },
        selector: { type: 'string' },
        value: { type: 'string' },
        key: { type: 'string' },
        url_pattern: { type: 'string' },
        method: { type: 'string' },
        text: { type: 'string' },
        duration: { type: 'number' },
        direction: { type: 'string', enum: ['top', 'bottom'] },
      },
    },

    // -------------------------------------------------------------------
    // FlowSpec
    // -------------------------------------------------------------------
    FlowSpec: {
      type: 'object',
      required: ['id', 'steps'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        steps: {
          type: 'array',
          items: { $ref: '#/$defs/FlowStep' },
        },
      },
    },

    FlowStep: {
      type: 'object',
      properties: {
        navigate: { type: 'string' },
        assert_page: { type: 'string' },
        action: { type: 'string' },
        description: { type: 'string' },
        selector: { type: 'string' },
        value: { type: 'string' },
        key: { type: 'string' },
        url_pattern: { type: 'string' },
        method: { type: 'string' },
        text: { type: 'string' },
        duration: { type: 'number' },
        direction: { type: 'string', enum: ['top', 'bottom'] },
      },
      // At least one of navigate, assert_page, or action must be present
      anyOf: [
        { required: ['navigate'] },
        { required: ['assert_page'] },
        { required: ['action'] },
      ],
    },

    // -------------------------------------------------------------------
    // HooksSpec
    // -------------------------------------------------------------------
    HooksSpec: {
      type: 'object',
      additionalProperties: false,
      properties: {
        setup: {
          type: 'array',
          items: { $ref: '#/$defs/HookStep' },
        },
        teardown: {
          type: 'array',
          items: { $ref: '#/$defs/HookStep' },
        },
      },
    },

    HookStep: {
      type: 'object',
      required: ['name', 'type'],
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['api_call', 'shell'] },
        method: { type: 'string' },
        url: { type: 'string' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        body: {},
        command: { type: 'string' },
        save_as: { type: 'string' },
      },
      allOf: [
        {
          if: { properties: { type: { const: 'api_call' } } },
          then: { required: ['method', 'url'] },
        },
        {
          if: { properties: { type: { const: 'shell' } } },
          then: { required: ['command'] },
        },
      ],
    },

    // -------------------------------------------------------------------
    // CliSpec (CLI verification)
    // -------------------------------------------------------------------
    CliSpec: {
      type: 'object',
      required: ['binary'],
      additionalProperties: false,
      properties: {
        binary: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        timeout_ms: { type: 'number' },
        commands: {
          type: 'array',
          items: { $ref: '#/$defs/CliCommandSpec' },
        },
        scenarios: {
          type: 'array',
          items: { $ref: '#/$defs/CliScenarioSpec' },
        },
      },
    },

    CliCommandSpec: {
      type: 'object',
      required: ['id', 'args'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        stdin: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        timeout_ms: { type: 'number' },
        expected_exit_code: { type: 'number' },
        expected_exit_codes: { type: 'array', items: { type: 'number' } },
        stdout_assertions: {
          type: 'array',
          items: { $ref: '#/$defs/CliOutputAssertion' },
        },
        stderr_assertions: {
          type: 'array',
          items: { $ref: '#/$defs/CliOutputAssertion' },
        },
      },
    },

    CliOutputAssertion: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['text_contains', 'text_matches', 'json_schema', 'json_path', 'empty', 'line_count'],
        },
        description: { type: 'string' },
        text: { type: 'string' },
        pattern: { type: 'string' },
        schema: { $ref: '#/$defs/JsonSchemaInline' },
        path: { type: 'string' },
        value: {},
        min: { type: 'number' },
        max: { type: 'number' },
      },
    },

    CliScenarioSpec: {
      type: 'object',
      required: ['id', 'steps'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        steps: {
          type: 'array',
          items: { $ref: '#/$defs/CliCommandSpec' },
        },
      },
    },

    // -------------------------------------------------------------------
    // Assumption (preconditions for valid testing)
    // -------------------------------------------------------------------
    Assumption: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['url_reachable', 'env_var_set', 'api_returns', 'selector_exists'],
        },
        description: { type: 'string' },
        url: { type: 'string' },
        name: { type: 'string' },
        method: { type: 'string' },
        status: { type: 'number' },
        selector: { type: 'string' },
      },
      allOf: [
        {
          if: { properties: { type: { const: 'url_reachable' } } },
          then: { required: ['url'] },
        },
        {
          if: { properties: { type: { const: 'env_var_set' } } },
          then: { required: ['name'] },
        },
        {
          if: { properties: { type: { const: 'api_returns' } } },
          then: { required: ['url'] },
        },
        {
          if: { properties: { type: { const: 'selector_exists' } } },
          then: { required: ['url', 'selector'] },
        },
      ],
    },

    // -------------------------------------------------------------------
    // DefaultProperties (universal properties across all pages)
    // -------------------------------------------------------------------
    DefaultProperties: {
      type: 'object',
      additionalProperties: false,
      properties: {
        no_5xx: { type: 'boolean' },
        no_console_errors: { type: 'boolean' },
        no_uncaught_exceptions: { type: 'boolean' },
        page_load_timeout_ms: { type: 'number' },
      },
    },
  },
} as const;
