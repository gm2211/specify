import assert from 'node:assert/strict';
import test from 'node:test';
import type { Spec } from '../spec/types.js';
import { validate, type CaptureData } from './validator.js';

test('validate keeps flow wait steps without url_pattern untested instead of crashing', () => {
  const spec: Spec = {
    version: '1.0',
    name: 'Flow validation regression',
    flows: [
      {
        id: 'missing-url-pattern',
        steps: [
          { action: 'wait_for_request', description: 'Wait for request' } as never,
          { action: 'wait_for_navigation', description: 'Wait for navigation' } as never,
        ],
      },
    ],
  };

  const capture: CaptureData = {
    directory: '/tmp/capture',
    traffic: [
      {
        url: 'https://app.example.test/api/users',
        method: 'GET',
        postData: null,
        status: 200,
        contentType: 'application/json',
        ts: 1,
        responseBody: '{}',
      },
    ],
    console: [],
    timestamp: '2026-03-18T00:00:00.000Z',
    targetUrl: 'https://app.example.test',
    totalRequests: 1,
  };

  const report = validate(spec, capture);
  const [requestStep, navigationStep] = report.flows[0]?.steps ?? [];

  assert.equal(requestStep?.status, 'untested');
  assert.match(requestStep?.reason ?? '', /missing url_pattern/);
  assert.equal(navigationStep?.status, 'untested');
  assert.match(navigationStep?.reason ?? '', /missing url_pattern/);
});
