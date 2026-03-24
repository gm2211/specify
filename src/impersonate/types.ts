/**
 * src/impersonate/types.ts — MockServer expectation and result types
 *
 * These types map to the MockServer REST API expectation format.
 * See: https://www.mock-server.com/mock_server/creating_expectations.html
 */

export interface MockServerExpectation {
  httpRequest: MockServerRequest;
  httpResponse: MockServerResponse;
  times?: { unlimited: boolean };
  priority?: number;
}

export interface MockServerRequest {
  method: string;
  path: string;
  queryStringParameters?: Record<string, string[]>;
  headers?: Record<string, string[]>;
  body?: { type: string; string?: string; json?: unknown };
}

export interface MockServerResponse {
  statusCode: number;
  headers?: Record<string, string[]>;
  body?: string;
  delay?: { timeUnit: string; value: number };
}

export interface ImpersonateResult {
  containerId: string;
  port: number;
  expectationCount: number;
  originalTrafficCount: number;
  syntheticTrafficCount: number;
  mockServerUrl: string;
}
