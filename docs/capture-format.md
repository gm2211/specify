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

## Format version

`traffic.json` entries have gone through one format revision so far,
tracked by `manifest.json`'s `formatVersion` field (see
`CaptureManifest` below):

- **Version 1** (implicit — no `formatVersion` field was ever written
  for this version): the original flat request/response pair shape —
  `url`, `method`, `postData`, `status`, `contentType`,
  `ts`/`tsStart`/`tsEnd`, `responseBody`.
- **Version 2**: adds the optional `requestHeaders`/`responseHeaders`
  fields described below (SP-lsc.8, mockify PR #4).

A manifest with no `formatVersion` field — every manifest written
before this field existed, or one that's missing/unreadable — must be
treated as version 1. mockify's `resolveCaptureFormatVersion()`
(`src/format/types.ts`) does exactly this: `manifest?.formatVersion ??
1`. specify's own capture writer (`src/agent/capture.ts`) does not yet
emit `requestHeaders`/`responseHeaders` or a `formatVersion` value —
see the compatibility note at the end of this section.

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
| `requestHeaders` | `Record<string, string>` (optional) | Request headers, redacted (see Redaction below) before the entry is ever written to disk. Header names are lower-cased, mirroring Playwright's `Request#allHeaders()`. Optional because it's new in format version 2 — every capture written before SP-lsc.8 simply lacks this field; loaders/matching must treat that the same as "no header constraints", not an error. |
| `responseHeaders` | `Record<string, string>` (optional) | Response headers, redacted the same way. A header that appeared multiple times on the real response (in practice only `Set-Cookie`) is packed into one string — see Multi-value headers below. Optional for the same reason as `requestHeaders`. |
| `injectedFault` | `string` (optional) | Set when the entry was synthetically produced by the seeded fault injector (`src/agent/fault-injector.ts`) rather than observed live — e.g. `"500"`, `"timeout"`, `"abort"`, `"empty"`. Evidence consumers should treat entries carrying this field as a manufactured resilience-test condition, not a genuine regression. |

**`ts` vs `tsEnd` backward compatibility**: `ts` is the original,
always-present field and equals `tsEnd` for entries captured after
`tsEnd` was introduced. `tsStart`/`tsEnd` are optional because older
captures written before those fields existed won't have them. New code
should prefer `tsEnd`; `ts` is kept only so that older `traffic.json`
files (and any consumer still reading it) keep working.

### Multi-value headers

`CapturedTraffic`'s header fields are `Record<string, string>` — one
string value per header name — but a real HTTP response can carry the
same header name more than once (in practice this only happens for
`Set-Cookie`). mockify packs repeated values into a single string
joined by `MULTI_VALUE_HEADER_SEPARATOR` (`"\n"`, a raw newline — it
can't appear inside a real header value, so it's a safe packing
separator), via `packMultiValueHeader`/`unpackMultiValueHeader`/
`packHeadersArray` in `src/format/headers.ts`. A single-value header
round-trips through packing as a one-element join (i.e. unchanged).
Any consumer that reads `responseHeaders['set-cookie']` (or, in
principle, any other repeatable header) must unpack it before treating
the value as one header line rather than several.

On replay, mockify's `buildReplayResponseHeaders()` unpacks
`set-cookie` back into a real string array so the HTTP server emits
one `Set-Cookie` line per value, and strips hop-by-hop headers
(`connection`, `keep-alive`, `transfer-encoding`, `content-length`,
`upgrade`, `proxy-authenticate`, `proxy-authorization`, `te`,
`trailer`) plus `content-type` (always set explicitly from the
entry's own `contentType` field instead). For matching an incoming
replay request against a recorded one, mockify's
`headersSubsetMatch()` does a subset check: every *significant*
recorded header — i.e. excluding both volatile headers (host,
user-agent, date, connection, content-length, accept*, cache-control,
pragma, referer, origin, the `sec-fetch-*`/`sec-ch-ua*` family,
`x-request-id`, `x-correlation-id`, and a few other connection/
negotiation headers that legitimately differ between capture time and
replay time) and credential-bearing headers (see Redaction below) —
must be present in the incoming request with the exact same value. An
`undefined`/empty recorded header set always matches, which is what
keeps a pre-SP-lsc.8 capture (no header data at all) replaying exactly
as it did before this module existed.

## Redaction

Because a capture directory can end up holding live bearer tokens,
session cookies, and API keys — mockify can capture against
authenticated targets via `--storage-state` — captures are redacted by
default before anything is written to disk. Redaction has two parts,
both implemented in mockify's `src/format/redact.ts` and applied at
every capture write path:

1. **Header values.** Any header whose name (case-insensitive) is one
   of `authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
   `x-api-key`, `x-auth-token`, `x-access-token`, `x-session-token`,
   `x-csrf-token`, or `x-xsrf-token` has its value replaced with the
   placeholder `[REDACTED]`. `set-cookie` gets one exception to the
   flat "whole value becomes `[REDACTED]`" rule: because its value may
   be a `MULTI_VALUE_HEADER_SEPARATOR`-packed string of several
   cookies, each packed value is redacted independently, so the count
   of `Set-Cookie` lines a redacted capture replays still matches what
   was actually observed (a single unpacked `Set-Cookie` value has
   nothing to split on and redacts to plain `[REDACTED]`, same as
   before).
2. **Body fields.** Request/response bodies are parsed as JSON (walked
   recursively, arrays included) or, failing that, as
   `key=value&key2=value2` form-encoded data; any key that
   case-insensitively contains `token`, `password`, `apikey` (matched
   after stripping non-alphanumeric separators, so `api_key`/`apiKey`/
   `API-KEY` all match), `secret`, `authorization`, `session`, or
   `bearer` has its value replaced with `[REDACTED]`. Anything that
   isn't JSON or form-encoded (plain text, opaque strings) is left
   unchanged — this is a best-effort pass, not a guarantee.

The placeholder is the stable string `[REDACTED]` (not random, not
omitted), so replay shape is preserved: a mock server replaying a
redacted response still returns a same-shaped object with the same
keys, just without the real secret value.

Redaction can be disabled per capture with mockify's `--no-redact` CLI
flag, or the `MOCKIFY_NO_REDACT` environment variable (truthy: `"1"`
or `"true"`, case-insensitive) for capture paths that can't thread a
CLI flag through. Whether redaction ran is recorded in
`manifest.json`'s `redaction` boolean field (see `CaptureManifest`
below) — `false` means the capture may contain live tokens/cookies/API
keys in plain text, and consumers/tooling that print or share capture
contents should treat that as a signal to be careful. specify's own
`manifest.json` writer does not currently emit a `redaction` field at
all (its `CaptureManifest` type predates this addition) — treat a
missing field the same as "unknown", not as `false`/plaintext, when
reading a manifest that specify itself produced.

## Compatibility

v1 captures — any `traffic.json` written before SP-lsc.8, or any
`manifest.json` with no `formatVersion` field — remain fully loadable.
`requestHeaders`/`responseHeaders` are optional precisely so that
older captures don't need to be migrated or rejected. Any consumer
that reads `CapturedTraffic` entries (in either repo) must treat these
two fields as possibly absent rather than assuming they're always
present, and must not use a strict/`additionalProperties: false`-style
schema to validate `traffic.json` entries, since that would reject
future format additions the same way. specify's own capture writer
does not yet emit `formatVersion` or the header fields — until it
does, every capture specify produces is implicitly version 1, and
mockify's consumers already handle that case by design.

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
| `redaction` | `boolean` | Whether credential redaction ran on this capture's bodies (and header values, where headers are captured at all) before anything was written to disk. `false` means the capture was taken with `--no-redact`/`MOCKIFY_NO_REDACT` and may contain live tokens/cookies/API keys in plain text. See Redaction below. |
| `formatVersion` | `number` (optional) | `traffic.json` entry format version — see Format version above. Absent on a manifest written before this field existed; treat a missing value the same as version `1`. |
| `trafficFile` | `string` | Path to `traffic.json`, relative to the capture directory. |
| `consoleFile` | `string` (optional) | Path to `console.json`, relative to the capture directory. May not exist. |
| `screenshotFiles` | `string[]` | Paths to screenshot PNGs, relative to the capture directory. |
| `summaryFile` | `string` (optional) | Path to `summary.txt`, relative to the capture directory. |
| `jsSourcesFile` | `string` (optional) | Path to `js-sources.json`, relative to the capture directory. |
| `observationsFile` | `string` (optional) | Path to `observations.json`, relative to the capture directory, if a runner-recorded per-step trace (`ObservationRecorder`) was written for this session. See `src/agent/observation.ts`. |

## Related issues

- **SP-9cf** — whether to publish a shared package for these types
  instead of each repo keeping its own copy.
- **SP-lsc.8** — header capture (format version 2: `requestHeaders`/
  `responseHeaders`, multi-value packing, redaction). Implemented on
  the mockify side (mockify PR #4, `gm2211/mockify@99e691a`). specify's
  own capture writer (`src/agent/capture.ts`) does not yet produce
  these fields — see the Compatibility note above.
- **SP-6iy** — this document was synced to mockify's format v2 as the
  source of truth; it does not itself change specify's capture writer.
