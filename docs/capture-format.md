# Capture format contract

`src/capture/types.ts` defines the on-disk shape of a capture session:
the `traffic.json`, `console.json`, and `manifest.json` files that
specify's capture path (`src/agent/capture.ts`) writes to a capture
output directory.

This same file format is what
[mockify](https://github.com/gm2211/mockify)'s mock server reads back
to replay traffic. Historically both tools lived in this repo and
shared the TypeScript types directly. After the mockify extraction,
each repo keeps its own copy of these interfaces on purpose — there is
no shared package. **The contract between the two repos is the file
format on disk, not the TypeScript.** If the shape of `traffic.json`,
`console.json`, or `manifest.json` changes, the change has to land in
both `specify` (the producer) and `mockify` (the consumer/replayer of
record), or replay will silently misread newer captures.

## Who reads what

- **specify** is the producer. `src/agent/capture.ts` is the only code
  that writes these files. Everything else in specify that touches
  these types does so `import type`-only — it reads the shape, never
  constructs or serializes it: `src/model/endpoint-map.ts`,
  `src/model/nav-model.ts`, `src/model/runner-hooks.ts`,
  `src/monitor/predicates.ts`, `src/monitor/verdict-merge.ts`, and
  `src/spec/generator.ts` (plus their `*.test.ts` files). None of
  specify's verification core depends on recorder code — only on this
  shape.
- **mockify** is the producer/consumer of record for replay: its mock
  server reads `traffic.json` to serve recorded responses back to a
  client, using the same field names described below.

## `CapturedTraffic`

One paired request + response, as an entry in the `traffic.json` array:

| Field | Type | Notes |
| --- | --- | --- |
| `url` | `string` | Full request URL. |
| `method` | `string` | HTTP method. |
| `postData` | `string \| null` | Request body, if any. |
| `status` | `number` | HTTP status code. |
| `contentType` | `string` | Response `Content-Type` header value. |
| `ts` | `number` | Unix ms. Historically the moment the response completed. |
| `tsStart` | `number` (optional) | Unix ms when the request was sent. Absent on older captures predating this field. |
| `tsEnd` | `number` (optional) | Unix ms when the response completed. Absent on older captures. |
| `responseBody` | `string \| null` | Response body, if captured. |
| `injectedFault` | `string` (optional) | Set when the entry was synthetically produced by the seeded fault injector (`src/agent/fault-injector.ts`) rather than observed live — e.g. `"500"`, `"timeout"`, `"abort"`, `"empty"`. Evidence consumers should treat entries carrying this field as a manufactured resilience-test condition, not a genuine regression. |

**`ts` vs `tsEnd` backward compatibility**: `ts` is the original,
always-present field and equals `tsEnd` for entries captured after
`tsEnd` was introduced. `tsStart`/`tsEnd` are optional because older
captures written before those fields existed won't have them. New code
should prefer `tsEnd`; `ts` is kept only so that older `traffic.json`
files (and any consumer still reading it) keep working.

## `CapturedConsoleEntry`

One entry in the optional `console.json` array:

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `string` | Console method: `log`, `warn`, `error`, `info`, `debug`, etc. |
| `text` | `string` | The logged text. |
| `ts` | `number` | Unix ms. |

## `CaptureManifest`

`manifest.json` — describes the other files in a capture session
directory so they can be discovered and loaded programmatically:

| Field | Type | Notes |
| --- | --- | --- |
| `session` | `CaptureSession` | Session metadata (timestamp, target URL, host filter, output dir, and counts of requests/screenshots/pages/console logs). |
| `trafficFile` | `string` | Path to `traffic.json`, relative to the capture directory. |
| `consoleFile` | `string` (optional) | Path to `console.json`, relative to the capture directory. May not exist. |
| `screenshotFiles` | `string[]` | Paths to screenshot PNGs, relative to the capture directory. |
| `summaryFile` | `string` (optional) | Path to `summary.txt`, relative to the capture directory. |
| `jsSourcesFile` | `string` (optional) | Path to `js-sources.json`, relative to the capture directory. |
| `observationsFile` | `string` (optional) | Path to `observations.json`, relative to the capture directory, if a runner-recorded per-step trace (`ObservationRecorder`) was written for this session. See `src/agent/observation.ts`. |

## Related issues

- **SP-9cf** — whether to publish a shared package for these types
  instead of each repo keeping its own copy.
- **SP-lsc.8** — header capture is a pending format change to this
  contract (not yet implemented as of this document).
