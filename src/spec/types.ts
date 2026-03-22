/**
 * src/spec/types.ts — Spec format types (v1 + v2 union)
 *
 * V1 (computable): describes HOW to verify with matchers, selectors, step sequences.
 * V2 (behavioral): describes WHAT should be true; agent figures out verification.
 *
 * Both versions coexist via discriminated union on the `version` field.
 */

// Re-export v2 types
export type {
  SpecV2,
  Target,
  WebTarget,
  CliTarget,
  ApiTarget,
  AssumptionV2,
  HookStepV2,
  HooksV2,
  Area,
  Behavior,
  VerificationReport,
  BehaviorResult,
  Evidence,
  GapAnalysisReport,
  BehaviorCoverage,
  MatchedTest,
  UnmappedTest,
} from './types-v2.js';

import type { SpecV2 } from './types-v2.js';

/** Discriminated union of v1 and v2 spec formats. */
export type Spec = SpecV1 | SpecV2;

/** Type guard: is this a v2 spec? */
export function isV2(spec: Spec): spec is SpecV2 {
  return spec.version === '2';
}

/** Type guard: is this a v1 spec? */
export function isV1(spec: Spec): spec is SpecV1 {
  return !isV2(spec);
}

// ---------------------------------------------------------------------------
// Assertion quantifiers and confidence (Antithesis-inspired)
// ---------------------------------------------------------------------------

/**
 * Quantifier for assertions: whether the assertion must hold on every run
 * ("always") or is expected to hold on at least some runs ("sometimes").
 */
export type AssertionQuantifier = 'always' | 'sometimes';

/**
 * Confidence level for an assertion, indicating how it was established:
 *   - "observed": derived from actual captured behavior
 *   - "inferred": inferred from documentation, patterns, or heuristics
 *   - "reviewed": manually reviewed and confirmed by a human
 */
export type AssertionConfidence = 'observed' | 'inferred' | 'reviewed';

// ---------------------------------------------------------------------------
// Default universal properties
// ---------------------------------------------------------------------------

/** Universal properties that should hold across all pages unless overridden. */
export interface DefaultProperties {
  /** If true, no HTTP response should have a 5xx status code. */
  no_5xx?: boolean;

  /** If true, no console.error entries should appear. */
  no_console_errors?: boolean;

  /** If true, no uncaught exceptions should appear in the console. */
  no_uncaught_exceptions?: boolean;

  /** Maximum page load time in milliseconds. */
  page_load_timeout_ms?: number;
}

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

/** A precondition that must hold for the spec to be validly tested. */
export type Assumption =
  | UrlReachableAssumption
  | EnvVarSetAssumption
  | ApiReturnsAssumption
  | SelectorExistsAssumption;

/** Base fields shared by all assumption types. */
interface BaseAssumption {
  /** Human-readable description of this assumption. */
  description?: string;
}

/** Assumption that a URL is reachable (responds with 2xx to a HEAD request). */
export interface UrlReachableAssumption extends BaseAssumption {
  type: 'url_reachable';
  /** URL that must be reachable. */
  url: string;
}

/** Assumption that an environment variable is set and non-empty. */
export interface EnvVarSetAssumption extends BaseAssumption {
  type: 'env_var_set';
  /** Name of the environment variable. */
  name: string;
}

/** Assumption that an API endpoint returns an expected status code. */
export interface ApiReturnsAssumption extends BaseAssumption {
  type: 'api_returns';
  /** URL of the API endpoint. */
  url: string;
  /** HTTP method (defaults to GET). */
  method?: string;
  /** Expected HTTP status code (defaults to 200). */
  status?: number;
}

/** Assumption that a CSS selector exists on a given page. */
export interface SelectorExistsAssumption extends BaseAssumption {
  type: 'selector_exists';
  /** URL of the page to check. */
  url: string;
  /** CSS selector that must exist. */
  selector: string;
}

// ---------------------------------------------------------------------------
// Top-level spec
// ---------------------------------------------------------------------------

/** Root spec document (v1 computable format). */
export interface SpecV1 {
  /** Spec format version. */
  version: string;

  /** Human-readable name for this spec. */
  name: string;

  /** Optional description of what this spec covers. */
  description?: string;

  /** Claims that ground normative prose in executable checks or verified requirements. */
  claims?: Claim[];

  /** Claim IDs that this top-level description relies on. */
  description_claims?: string[];

  /** Pages/views in the application. */
  pages?: PageSpec[];

  /** Multi-page flows (e.g. login-to-dashboard). */
  flows?: FlowSpec[];

  /** CLI command verification. */
  cli?: CliSpec;

  /** Setup and teardown hooks. */
  hooks?: HooksSpec;

  /** Template variables and configuration. */
  variables?: Record<string, string>;

  /** Preconditions that must hold for this spec to be validly tested. */
  assumptions?: Assumption[];

  /** Universal properties that apply across all pages by default. */
  defaults?: DefaultProperties;

  /** Path to companion narrative document (relative to spec file). */
  narrative_path?: string;

  /** Embedded narrative sections with prose and grouped requirements. */
  narrative?: NarrativeSection[];

  /** Behavioral requirements that need agent intelligence to validate. */
  requirements?: Requirement[];
}

// ---------------------------------------------------------------------------
// Normative claims
// ---------------------------------------------------------------------------

/** A normative claim grounded by executable checks and/or verified requirements. */
export interface Claim {
  /** Unique identifier. */
  id: string;

  /** Normative statement that should be provably true. */
  description: string;

  /** How this claim is grounded by mechanical checks or behavioral requirements. */
  grounded_by: ClaimGrounding;
}

/** References that prove a claim. All listed refs must pass for the claim to pass. */
export interface ClaimGrounding {
  /** Individual CLI command IDs whose successful results ground this claim. */
  commands?: string[];

  /** CLI scenario IDs whose successful results ground this claim. */
  scenarios?: string[];

  /** Behavioral requirement IDs whose verified evidence grounds this claim. */
  requirements?: string[];
}

// ---------------------------------------------------------------------------
// Behavioral requirements
// ---------------------------------------------------------------------------

/** A behavioral requirement — a property that needs judgment to validate. */
export interface Requirement {
  /** Unique identifier. */
  id: string;

  /** What should be true — clear enough for an agent to plan validation. */
  description: string;

  /** How this requirement is verified: "mechanical" or "agent". */
  verification: 'mechanical' | 'agent';

  /** Steps an agent should take to validate this requirement. */
  validation_plan?: string;

  /** What evidence the agent should produce. */
  evidence_format?: string;

  /**
   * Inline property checks — CLI commands with assertions that verify
   * evaluates directly instead of looking for external evidence files.
   * Each check is a CLI command spec run against the spec's cli.binary.
   */
  checks?: CliCommandSpec[];

  /** Optional human-readable narrative context for this requirement. */
  narrative?: string;
}

// ---------------------------------------------------------------------------
// Narrative sections (embedded prose)
// ---------------------------------------------------------------------------

/** A narrative section that groups related requirements and spec items with prose. */
export interface NarrativeSection {
  /** Section title. */
  section: string;

  /** Human-readable prose describing this capability area. */
  prose: string;

  /** Requirements defined within this narrative section. */
  requirements?: Requirement[];

  /** IDs of other spec items (CLI commands, claims, etc.) that this section covers. */
  covers?: string[];
}

// ---------------------------------------------------------------------------
// CLI verification
// ---------------------------------------------------------------------------

/** Specification for verifying a CLI tool. */
export interface CliSpec {
  /** Binary or command to invoke (e.g. "node dist/cli.js", "cargo run --"). */
  binary: string;

  /** Environment variables to set for all commands. */
  env?: Record<string, string>;

  /** Default timeout in milliseconds for commands. */
  timeout_ms?: number;

  /** Individual commands to verify. */
  commands?: CliCommandSpec[];

  /** Multi-command scenarios (sequential commands with shared state). */
  scenarios?: CliScenarioSpec[];
}

/** A single CLI command invocation with expected behavior. */
export interface CliCommandSpec {
  /** Unique identifier for this command. */
  id: string;

  /** Human-readable description. */
  description?: string;

  /** Claim IDs that explicitly ground this command description. */
  description_claims?: string[];

  /** Command-line arguments (each element is one arg). */
  args: string[];

  /** Data to pipe to stdin. */
  stdin?: string;

  /** Per-command environment variables (merged with CliSpec.env). */
  env?: Record<string, string>;

  /** Timeout in milliseconds for this command (overrides CliSpec.timeout_ms). */
  timeout_ms?: number;

  /** Expected exit code (default: 0). */
  expected_exit_code?: number;

  /** Acceptable exit codes (alternative to single expected_exit_code). */
  expected_exit_codes?: number[];

  /** Assertions on stdout. */
  stdout_assertions?: CliOutputAssertion[];

  /** Assertions on stderr. */
  stderr_assertions?: CliOutputAssertion[];
}

/** Assertions that can be applied to CLI stdout or stderr output. */
export type CliOutputAssertion =
  | CliTextContainsAssertion
  | CliTextMatchesAssertion
  | CliJsonSchemaAssertion
  | CliJsonPathAssertion
  | CliEmptyAssertion
  | CliLineCountAssertion;

/** Assert output contains a substring. */
export interface CliTextContainsAssertion {
  type: 'text_contains';
  /** Substring that must appear. */
  text: string;
  /** Human-readable description. */
  description?: string;
}

/** Assert output matches a regex pattern. */
export interface CliTextMatchesAssertion {
  type: 'text_matches';
  /** Regex pattern. */
  pattern: string;
  /** Human-readable description. */
  description?: string;
}

/** Assert output is valid JSON matching a JSON Schema. */
export interface CliJsonSchemaAssertion {
  type: 'json_schema';
  /** JSON Schema to validate against. */
  schema: JsonSchema;
  /** Human-readable description. */
  description?: string;
}

/** Assert a specific JSON path has an expected value. */
export interface CliJsonPathAssertion {
  type: 'json_path';
  /** Dot-separated path (e.g. "name", "commands.0.name", "error"). */
  path: string;
  /** Expected value at that path. */
  value: unknown;
  /** Human-readable description. */
  description?: string;
}

/** Assert output is empty. */
export interface CliEmptyAssertion {
  type: 'empty';
  /** Human-readable description. */
  description?: string;
}

/** Assert line count of output. */
export interface CliLineCountAssertion {
  type: 'line_count';
  /** Minimum line count (inclusive). */
  min?: number;
  /** Maximum line count (inclusive). */
  max?: number;
  /** Human-readable description. */
  description?: string;
}

/** A multi-command CLI scenario. */
export interface CliScenarioSpec {
  /** Unique identifier. */
  id: string;
  /** Human-readable description. */
  description?: string;
  /** Claim IDs that explicitly ground this scenario description. */
  description_claims?: string[];
  /** Commands to run in sequence. */
  steps: CliCommandSpec[];
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** A single page or view in the application. */
export interface PageSpec {
  /** Unique identifier for this page (referenced by flows). */
  id: string;

  /** URL path or pattern (e.g. "/dashboard", "/users/:id"). */
  path: string;

  /** Expected page title — exact string or regex pattern. */
  title?: string;

  /** Visual assertions: what should be visible on this page. */
  visual_assertions?: VisualAssertion[];

  /** Network requests expected when this page loads. */
  expected_requests?: ExpectedRequest[];

  /** Console output expectations. */
  console_expectations?: ConsoleExpectation[];

  /** Interactive scenarios on this page. */
  scenarios?: ScenarioSpec[];
}

// ---------------------------------------------------------------------------
// Visual assertions
// ---------------------------------------------------------------------------

/** Discriminated union of visual assertion types. */
export type VisualAssertion =
  | ElementExistsAssertion
  | TextContainsAssertion
  | TextMatchesAssertion
  | ScreenshotRegionAssertion
  | ElementCountAssertion;

interface BaseVisualAssertion {
  /** Human-readable description of what this assertion checks. */
  description?: string;

  /** Whether this assertion must hold always or only sometimes. */
  quantifier?: AssertionQuantifier;

  /** How this assertion was established. */
  confidence?: AssertionConfidence;
}

/** Assert that an element matching the selector exists in the DOM. */
export interface ElementExistsAssertion extends BaseVisualAssertion {
  type: 'element_exists';
  /** CSS selector for the element. */
  selector: string;
}

/** Assert that an element's text contains the given substring. */
export interface TextContainsAssertion extends BaseVisualAssertion {
  type: 'text_contains';
  /** CSS selector for the element. */
  selector: string;
  /** Expected text substring. */
  text: string;
}

/** Assert that an element's text matches a regex pattern. */
export interface TextMatchesAssertion extends BaseVisualAssertion {
  type: 'text_matches';
  /** CSS selector for the element. */
  selector: string;
  /** Regex pattern the text should match. */
  pattern: string;
}

/** Assert that a screenshot region renders correctly (visual regression). */
export interface ScreenshotRegionAssertion extends BaseVisualAssertion {
  type: 'screenshot_region';
  /** CSS selector defining the region to capture. */
  selector: string;
}

/** Assert the count of elements matching a selector. */
export interface ElementCountAssertion extends BaseVisualAssertion {
  type: 'element_count';
  /** CSS selector for the elements. */
  selector: string;
  /** Minimum expected count (inclusive). */
  min?: number;
  /** Maximum expected count (inclusive). */
  max?: number;
}

// ---------------------------------------------------------------------------
// Expected requests
// ---------------------------------------------------------------------------

/** An HTTP request expected when a page loads or an action is performed. */
export interface ExpectedRequest {
  /** HTTP method (GET, POST, PUT, DELETE, etc). */
  method: string;

  /**
   * URL pattern to match. Supports:
   *   - Exact path: "/api/users"
   *   - Glob wildcards: "/api/users/*"
   *   - Regex: "^/api/users/\\d+$" (when prefixed with ^)
   */
  url_pattern: string;

  /** Human-readable description. */
  description?: string;

  /** Expected request body shape (for POST/PUT). */
  request_body?: RequestBodySpec;

  /** Expected response shape. */
  response?: ExpectedResponse;

  /** Whether this request must always or only sometimes be observed. */
  quantifier?: AssertionQuantifier;

  /** How this assertion was established. */
  confidence?: AssertionConfidence;
}

/** Expected shape of a request body. */
export interface RequestBodySpec {
  /** Content type (e.g. "application/json"). */
  content_type?: string;

  /** JSON Schema for the body (when content type is JSON). */
  body_schema?: JsonSchema;
}

/** Expected response shape. */
export interface ExpectedResponse {
  /** Expected HTTP status code. */
  status?: number;

  /** Acceptable status codes (alternative to single status). */
  status_in?: number[];

  /** Content type pattern (substring match). */
  content_type?: string;

  /** JSON Schema for the response body. */
  body_schema?: JsonSchema;
}

/**
 * Inline JSON Schema definition.
 * Uses a subset of JSON Schema Draft 7 to keep specs readable.
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
}

// ---------------------------------------------------------------------------
// Console expectations
// ---------------------------------------------------------------------------

/** Expectation about browser console output. */
export interface ConsoleExpectation {
  /** Console level to check: error, warn, log, info, debug. */
  level: string;

  /** Maximum number of messages at this level (0 = none expected). */
  count?: number;

  /** If set, assert no messages match this pattern at the given level. */
  exclude_pattern?: string;

  /** Whether this expectation must hold always or only sometimes. */
  quantifier?: AssertionQuantifier;

  /** How this expectation was established. */
  confidence?: AssertionConfidence;
}

// ---------------------------------------------------------------------------
// Scenarios (interactions within a page)
// ---------------------------------------------------------------------------

/** An interactive scenario describing a user workflow on a single page. */
export interface ScenarioSpec {
  /** Unique identifier for this scenario. */
  id: string;

  /** Human-readable description. */
  description?: string;

  /** Ordered steps the user performs. */
  steps: ScenarioStep[];
}

/** A single step in a scenario. */
export type ScenarioStep =
  | ClickStep
  | FillStep
  | SelectStep
  | HoverStep
  | WaitForRequestStep
  | WaitForNavigationStep
  | AssertVisibleStep
  | AssertTextStep
  | AssertNotVisibleStep
  | KeypressStep
  | ScrollStep
  | WaitStep;

interface BaseStep {
  /** Human-readable description of this step. */
  description?: string;
}

/** Click an element. */
export interface ClickStep extends BaseStep {
  action: 'click';
  /** CSS selector for the element to click. */
  selector: string;
}

/** Fill in an input field. */
export interface FillStep extends BaseStep {
  action: 'fill';
  /** CSS selector for the input element. */
  selector: string;
  /** Value to type (supports {{var}} templates). */
  value: string;
}

/** Select an option from a dropdown. */
export interface SelectStep extends BaseStep {
  action: 'select';
  /** CSS selector for the select element. */
  selector: string;
  /** Option value to select. */
  value: string;
}

/** Hover over an element. */
export interface HoverStep extends BaseStep {
  action: 'hover';
  /** CSS selector for the element to hover. */
  selector: string;
}

/** Wait for a network request matching a URL pattern. */
export interface WaitForRequestStep extends BaseStep {
  action: 'wait_for_request';
  /** URL pattern to wait for (supports glob wildcards). */
  url_pattern: string;
  /** Expected HTTP method (default: any). */
  method?: string;
}

/** Wait for navigation to a URL matching a pattern. */
export interface WaitForNavigationStep extends BaseStep {
  action: 'wait_for_navigation';
  /** URL pattern the browser should navigate to. */
  url_pattern: string;
}

/** Assert that an element is visible on the page. */
export interface AssertVisibleStep extends BaseStep {
  action: 'assert_visible';
  /** CSS selector for the element to check. */
  selector: string;
}

/** Assert that an element contains specific text. */
export interface AssertTextStep extends BaseStep {
  action: 'assert_text';
  /** CSS selector for the element. */
  selector: string;
  /** Expected text content (substring match). */
  text: string;
}

/** Assert that an element is NOT visible on the page. */
export interface AssertNotVisibleStep extends BaseStep {
  action: 'assert_not_visible';
  /** CSS selector for the element. */
  selector: string;
}

/** Press a key or key combination. */
export interface KeypressStep extends BaseStep {
  action: 'keypress';
  /** Key or key combination (e.g. "Enter", "Control+A"). */
  key: string;
}

/** Scroll to an element or position. */
export interface ScrollStep extends BaseStep {
  action: 'scroll';
  /** CSS selector to scroll to (optional — scrolls to top/bottom if omitted). */
  selector?: string;
  /** Scroll direction when no selector: "top" or "bottom". */
  direction?: 'top' | 'bottom';
}

/** Wait for a fixed duration (ms). Use sparingly. */
export interface WaitStep extends BaseStep {
  action: 'wait';
  /** Duration in milliseconds. */
  duration: number;
}

// ---------------------------------------------------------------------------
// Flows (multi-page journeys)
// ---------------------------------------------------------------------------

/** A multi-page user flow (e.g. login -> dashboard -> settings). */
export interface FlowSpec {
  /** Unique identifier for this flow. */
  id: string;

  /** Human-readable description. */
  description?: string;

  /** Ordered steps in the flow. */
  steps: FlowStep[];
}

/** A single step in a flow. Each step is one of several types. */
export type FlowStep =
  | NavigateFlowStep
  | AssertPageFlowStep
  | ActionFlowStep;

/** Navigate to a URL. */
export interface NavigateFlowStep {
  /** URL path to navigate to (supports {{var}} templates). */
  navigate: string;

  /** Human-readable description. */
  description?: string;
}

/** Assert the current page matches a page spec by id. */
export interface AssertPageFlowStep {
  /** References a PageSpec.id. */
  assert_page: string;

  /** Human-readable description. */
  description?: string;
}

/** Perform an interactive action (same as scenario steps). */
export type ActionFlowStep = ScenarioStep;

// ---------------------------------------------------------------------------
// Hooks (setup / teardown)
// ---------------------------------------------------------------------------

/** Setup and teardown hooks for test environment preparation. */
export interface HooksSpec {
  /** Steps to run before validation (create test data, etc). */
  setup?: HookStep[];

  /** Steps to run after validation (clean up test data, etc). */
  teardown?: HookStep[];
}

/** A single hook step. */
export type HookStep = ApiCallHookStep | ShellHookStep;

/** Make an HTTP API call (for setup/teardown of test data). */
export interface ApiCallHookStep {
  /** Human-readable name for this step. */
  name: string;

  type: 'api_call';

  /** HTTP method. */
  method: string;

  /** URL (supports {{var}} and ${ENV_VAR} templates). */
  url: string;

  /** Optional request headers. */
  headers?: Record<string, string>;

  /** Optional request body (will be JSON-serialized). */
  body?: unknown;

  /** Save the JSON response under this variable name for later use. */
  save_as?: string;
}

/** Run a shell command (for setup/teardown). */
export interface ShellHookStep {
  /** Human-readable name for this step. */
  name: string;

  type: 'shell';

  /** Shell command to run. */
  command: string;

  /** Save stdout under this variable name. */
  save_as?: string;
}
