/**
 * src/e2e/types.ts — Bridge data model between e2e tests and specs
 *
 * Framework-agnostic intermediate representation of e2e test files,
 * used for import, export, and bidirectional sync.
 */

// ---------------------------------------------------------------------------
// Test file analysis (parsed from existing e2e tests)
// ---------------------------------------------------------------------------

/** Result of analyzing a single test file. */
export interface TestFileAnalysis {
  /** Absolute path to the test file. */
  filePath: string;

  /** Detected framework. */
  framework: TestFramework;

  /** Top-level suites (describe blocks). */
  suites: TestSuite[];

  /** Standalone test cases not inside a suite. */
  tests: TestCase[];
}

/** Supported test frameworks. */
export type TestFramework = 'playwright' | 'cypress' | 'unknown';

/** A describe/suite block containing test cases. */
export interface TestSuite {
  /** Suite name (from describe/context string). */
  name: string;

  /** Nested test cases. */
  tests: TestCase[];

  /** Source location in the file. */
  sourceRange: SourceRange;
}

/** A single test case extracted from a test file. */
export interface TestCase {
  /** Test name (from it/test string). */
  name: string;

  /** URLs navigated to (page.goto / cy.visit). */
  navigations: string[];

  /** User interactions (click, fill, type, etc.). */
  interactions: TestInteraction[];

  /** Assertions found in the test. */
  assertions: TestAssertion[];

  /** Network interception patterns (waitForRequest / cy.intercept). */
  networkPatterns: NetworkPattern[];

  /** Source location in the file. */
  sourceRange: SourceRange;

  /** Raw source code of the test body. */
  rawSource: string;
}

/** A user interaction extracted from test code. */
export interface TestInteraction {
  /** Interaction type. */
  type: 'click' | 'fill' | 'select' | 'hover' | 'keypress' | 'scroll' | 'other';

  /** CSS selector or locator string. */
  selector?: string;

  /** Value for fill/type/select actions. */
  value?: string;

  /** Raw source expression. */
  raw: string;
}

/** An assertion extracted from test code. */
export interface TestAssertion {
  /** Assertion type. */
  type: 'visible' | 'text' | 'not_visible' | 'exists' | 'count' | 'url' | 'other';

  /** CSS selector or locator string. */
  selector?: string;

  /** Expected text or value. */
  expected?: string;

  /** Raw source expression. */
  raw: string;
}

/** A network interception pattern. */
export interface NetworkPattern {
  /** URL pattern being intercepted/waited for. */
  urlPattern: string;

  /** HTTP method if specified. */
  method?: string;

  /** Raw source expression. */
  raw: string;
}

/** Line range in a source file. */
export interface SourceRange {
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Code generation (spec → test)
// ---------------------------------------------------------------------------

/** A generated test file ready to be written. */
export interface GeneratedTestFile {
  /** Suggested file path (relative). */
  filePath: string;

  /** Generated test code. */
  content: string;

  /** Framework the code targets. */
  framework: TestFramework;

  /** Spec items that produced this file. */
  sourceSpecIds: string[];
}

/** Options for test code generation. */
export interface GenerateOptions {
  /** Target framework. */
  framework: 'playwright' | 'cypress';

  /** Base URL for the application. */
  baseUrl?: string;

  /** Output directory for generated files. */
  outputDir?: string;

  /** Whether to generate one file per page/flow or a single file. */
  splitFiles?: boolean;
}

// ---------------------------------------------------------------------------
// Sync report (bidirectional comparison)
// ---------------------------------------------------------------------------

/** Result of comparing specs against existing tests. */
export interface SyncReport {
  /** Spec items that have no corresponding test coverage. */
  uncoveredSpecItems: UncoveredSpecItem[];

  /** Test cases that don't map to any spec item. */
  unmappedTests: UnmappedTest[];

  /** Cases where spec and test exist but differ. */
  mismatches: SyncMismatch[];

  /** Matched pairs (spec item ↔ test). */
  matched: MatchedPair[];

  /** Summary statistics. */
  summary: SyncSummary;
}

/** A spec item with no corresponding test. */
export interface UncoveredSpecItem {
  /** Type of spec item. */
  type: 'page' | 'scenario' | 'flow';

  /** Spec item id. */
  specId: string;

  /** Path or description for context. */
  context: string;

  /** The spec fragment for LLM callers to act on. */
  specFragment: unknown;
}

/** A test case with no corresponding spec item. */
export interface UnmappedTest {
  /** Test case name. */
  testName: string;

  /** File containing the test. */
  filePath: string;

  /** The analysis for LLM callers to act on. */
  analysis: TestCase;
}

/** A case where spec and test exist but assertions differ. */
export interface SyncMismatch {
  /** Spec item id. */
  specId: string;

  /** Test case name. */
  testName: string;

  /** What differs. */
  differences: string[];
}

/** A successfully matched spec item ↔ test pair. */
export interface MatchedPair {
  /** Spec item id. */
  specId: string;

  /** Test case name. */
  testName: string;

  /** File containing the test. */
  filePath: string;
}

/** Summary of sync comparison. */
export interface SyncSummary {
  totalSpecItems: number;
  totalTests: number;
  matched: number;
  uncoveredSpecItems: number;
  unmappedTests: number;
  mismatches: number;
  syncPercentage: number;
}
