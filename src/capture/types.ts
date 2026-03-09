/**
 * src/capture/types.ts — TypeScript types for capture output
 *
 * These types describe the data produced by the capture scripts
 * (browse-and-capture.mjs, cdp-capture.ts) and consumed by the
 * spec generator and future validator.
 */

/** Metadata about a capture session. */
export interface CaptureSession {
  /** ISO 8601 timestamp when the capture started. */
  timestamp: string;

  /** Base URL of the target application. */
  targetUrl: string;

  /** Hostname filter used during capture. */
  hostFilter: string;

  /** Absolute path to the capture output directory. */
  outputDir: string;

  /** Total number of requests captured. */
  totalRequests: number;

  /** Total number of screenshots taken. */
  totalScreenshots: number;

  /** Number of unique pages visited. */
  pagesVisited: number;

  /** Number of console log entries captured. */
  consoleLogCount: number;
}

/** A captured HTTP request. */
export interface CapturedRequest {
  /** Full request URL including query string. */
  url: string;

  /** HTTP method (GET, POST, PUT, DELETE, etc). */
  method: string;

  /** Request headers. */
  headers?: Record<string, string>;

  /** POST/PUT body data, if any. */
  postData?: string | null;
}

/** A captured HTTP response. */
export interface CapturedResponse {
  /** HTTP status code. */
  status: number;

  /** Response content type header value. */
  contentType: string;

  /** Response body as a string, if captured (JSON/text only). */
  body?: string | null;
}

/** A paired request + response captured during browsing. */
export interface CapturedTraffic {
  /** Full request URL. */
  url: string;

  /** HTTP method. */
  method: string;

  /** POST body data, if any. */
  postData: string | null;

  /** HTTP status code. */
  status: number;

  /** Content-Type header value. */
  contentType: string;

  /** Unix timestamp in milliseconds. */
  ts: number;

  /** Response body as string, if captured. */
  responseBody: string | null;
}

/** A browser console log entry. */
export interface CapturedConsoleEntry {
  /** Console method type: log, warn, error, info, debug, etc. */
  type: string;

  /** The logged text. */
  text: string;

  /** Unix timestamp in milliseconds. */
  ts: number;
}

/**
 * Manifest describing all files in a capture session directory.
 * Used to discover and load capture data programmatically.
 */
export interface CaptureManifest {
  /** Session metadata. */
  session: CaptureSession;

  /** Path to traffic.json relative to the capture directory. */
  trafficFile: string;

  /** Path to console.json relative to the capture directory (may not exist). */
  consoleFile?: string;

  /** Paths to screenshot PNGs relative to the capture directory. */
  screenshotFiles: string[];

  /** Path to summary.txt relative to the capture directory. */
  summaryFile?: string;

  /** Path to js-sources.json relative to the capture directory. */
  jsSourcesFile?: string;
}
