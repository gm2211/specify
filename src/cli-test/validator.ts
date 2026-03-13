/**
 * src/cli-test/validator.ts — Validate CLI command output against spec
 */

import Ajv from 'ajv';
import type { CliCommandSpec, CliOutputAssertion } from '../spec/types.js';
import type { CliCommandRun, CliCommandResult, CliAssertionResult, CliExitCodeResult } from './types.js';

const ajv = new Ajv({ allErrors: true });

/** Validate a single command run against its spec. */
export function validateCommandRun(spec: CliCommandSpec, run: CliCommandRun): CliCommandResult {
  // Exit code check
  const exitCode = validateExitCode(spec, run);

  // Output assertions
  const stdoutAssertions = (spec.stdout_assertions ?? []).map(a =>
    validateOutputAssertion(a, run.stdout, 'stdout')
  );
  const stderrAssertions = (spec.stderr_assertions ?? []).map(a =>
    validateOutputAssertion(a, run.stderr, 'stderr')
  );

  // Overall status
  const allChecks = [
    exitCode.status,
    ...stdoutAssertions.map(a => a.status),
    ...stderrAssertions.map(a => a.status),
  ];
  const status = allChecks.includes('failed') ? 'failed' as const
    : allChecks.includes('untested') ? 'untested' as const
    : 'passed' as const;

  return {
    commandId: spec.id,
    description: spec.description,
    args: spec.args,
    status,
    exitCode,
    stdoutAssertions,
    stderrAssertions,
    durationMs: run.durationMs,
    timedOut: run.timedOut,
  };
}

function validateExitCode(spec: CliCommandSpec, run: CliCommandRun): CliExitCodeResult {
  if (run.timedOut) {
    return {
      expected: spec.expected_exit_codes ?? spec.expected_exit_code ?? 0,
      actual: run.exitCode,
      status: 'failed',
    };
  }

  const expectedCodes = spec.expected_exit_codes ?? [spec.expected_exit_code ?? 0];
  const passed = expectedCodes.includes(run.exitCode);

  return {
    expected: expectedCodes.length === 1 ? expectedCodes[0] : expectedCodes,
    actual: run.exitCode,
    status: passed ? 'passed' : 'failed',
  };
}

function validateOutputAssertion(
  assertion: CliOutputAssertion,
  output: string,
  _stream: 'stdout' | 'stderr',
): CliAssertionResult {
  switch (assertion.type) {
    case 'text_contains':
      return validateTextContains(assertion.text, output, assertion.description);

    case 'text_matches':
      return validateTextMatches(assertion.pattern, output, assertion.description);

    case 'json_schema':
      return validateJsonSchema(assertion.schema, output, assertion.description);

    case 'json_path':
      return validateJsonPath(assertion.path, assertion.value, output, assertion.description);

    case 'empty':
      return {
        type: 'empty',
        description: assertion.description,
        status: output.trim() === '' ? 'passed' : 'failed',
        reason: output.trim() !== '' ? `Expected empty output but got ${output.length} chars` : undefined,
      };

    case 'line_count': {
      const lineCount = output === '' ? 0 : output.split('\n').length;
      const minOk = assertion.min === undefined || lineCount >= assertion.min;
      const maxOk = assertion.max === undefined || lineCount <= assertion.max;
      return {
        type: 'line_count',
        description: assertion.description,
        status: minOk && maxOk ? 'passed' : 'failed',
        actual: lineCount,
        expected: assertion.min !== undefined && assertion.max !== undefined
          ? `${assertion.min}-${assertion.max}`
          : assertion.min !== undefined ? `>=${assertion.min}` : `<=${assertion.max}`,
        reason: !(minOk && maxOk) ? `Line count ${lineCount} out of range` : undefined,
      };
    }

    default:
      return {
        type: (assertion as { type: string }).type,
        description: (assertion as { description?: string }).description,
        status: 'untested',
        reason: `Unknown assertion type`,
      };
  }
}

function validateTextContains(text: string, output: string, description?: string): CliAssertionResult {
  const passed = output.includes(text);
  return {
    type: 'text_contains',
    description,
    status: passed ? 'passed' : 'failed',
    expected: text,
    reason: passed ? undefined : `Output does not contain "${text}"`,
  };
}

function validateTextMatches(pattern: string, output: string, description?: string): CliAssertionResult {
  try {
    const regex = new RegExp(pattern, 'm');
    const passed = regex.test(output);
    return {
      type: 'text_matches',
      description,
      status: passed ? 'passed' : 'failed',
      expected: pattern,
      reason: passed ? undefined : `Output does not match pattern /${pattern}/`,
    };
  } catch (err) {
    return {
      type: 'text_matches',
      description,
      status: 'failed',
      reason: `Invalid regex: ${(err as Error).message}`,
    };
  }
}

function validateJsonSchema(schema: unknown, output: string, description?: string): CliAssertionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      type: 'json_schema',
      description,
      status: 'failed',
      reason: 'Output is not valid JSON',
    };
  }

  try {
    const validate = ajv.compile(schema as object);
    const valid = validate(parsed);
    if (valid) {
      return { type: 'json_schema', description, status: 'passed' };
    }
    const errors = (validate.errors ?? []).map(e =>
      `${e.instancePath || '/'}: ${e.message}`
    );
    return {
      type: 'json_schema',
      description,
      status: 'failed',
      reason: `Schema validation failed: ${errors.join('; ')}`,
    };
  } catch (err) {
    return {
      type: 'json_schema',
      description,
      status: 'failed',
      reason: `Schema compilation error: ${(err as Error).message}`,
    };
  }
}

function validateJsonPath(jsonPath: string, expectedValue: unknown, output: string, description?: string): CliAssertionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      type: 'json_path',
      description,
      status: 'failed',
      reason: 'Output is not valid JSON',
    };
  }

  const actual = getByPath(parsed, jsonPath);

  // Deep equality
  const passed = JSON.stringify(actual) === JSON.stringify(expectedValue);

  return {
    type: 'json_path',
    description,
    status: passed ? 'passed' : 'failed',
    expected: expectedValue,
    actual,
    reason: passed ? undefined : `At path "${jsonPath}": expected ${JSON.stringify(expectedValue)} but got ${JSON.stringify(actual)}`,
  };
}

/** Get a value from an object by dot-separated path. Supports array indices. */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      // Try as array index first
      const idx = parseInt(part, 10);
      if (!isNaN(idx) && Array.isArray(current)) {
        current = current[idx];
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    } else {
      return undefined;
    }
  }
  return current;
}
