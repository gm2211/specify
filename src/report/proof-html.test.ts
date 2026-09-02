import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, renderProofHtml, type ProofInput, type ProofArea, type ProofBehavior } from './proof-html.js';

function baseBehavior(overrides: Partial<ProofBehavior> = {}): ProofBehavior {
  return {
    id: 'area-a/behavior-a',
    description: 'Does the thing',
    status: 'passed',
    monitor: [],
    guarantees: [],
    evidence: [],
    trace: [],
    frames: [],
    cliSteps: [],
    counts: { runnerRecorded: 0, agentReported: 0 },
    ...overrides,
  };
}

function baseInput(overrides: Partial<ProofInput> = {}): ProofInput {
  const areas: ProofArea[] = overrides.areas ?? [
    { id: 'area-a', name: 'Area A', behaviors: [baseBehavior()] },
  ];
  return {
    generator: { version: '1.2.3', generatedAt: '2026-01-01T00:00:00.000Z', commandLine: 'specify prove' },
    spec: { name: 'Test Spec', version: '2', path: '/tmp/spec.yaml' },
    target: { type: 'web', url: 'http://localhost:3000' },
    run: {
      timestamp: '2026-01-01T00:00:00.000Z',
      pass: true,
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, untested: 0 },
    },
    areas,
    screenshots: {},
    sessionFrames: [],
    cliSession: [],
    integrity: {
      inputDir: '/tmp/verify',
      outputPath: '/tmp/verify/proof.html',
      files: [],
      screenshotsEmbedded: 0,
      screenshotsLinked: 0,
      screenshotEncodedBytes: 0,
      screenshotByteCap: 1024,
      generatorVersion: '1.2.3',
      generatedAt: '2026-01-01T00:00:00.000Z',
      regenerateCommand: 'specify prove --spec /tmp/spec.yaml --input /tmp/verify --output /tmp/verify/proof.html',
    },
    ...overrides,
  };
}

test('escapeHtml escapes the five special characters and coerces null/undefined to empty string', () => {
  assert.equal(escapeHtml(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
});

test('agent-controlled text cannot become markup or break out of the JSON payload', () => {
  const input = baseInput({
    spec: { name: 'A & B "q" <b>', version: '2', path: '/tmp/spec.yaml' },
    areas: [
      {
        id: 'area-a',
        name: 'Area A',
        behaviors: [
          baseBehavior({
            description: '<img src=x onerror=alert(1)>',
            evidence: [
              {
                type: 'text',
                label: 'claim',
                content: '</script><script>alert(1)</script>',
                provenance: 'agent-reported',
                matchReason: 'agent narration',
              },
            ],
          }),
        ],
      },
    ],
  });
  const html = renderProofHtml(input);

  assert.ok(!html.includes('<img src=x'), 'raw <img> tag must not appear');
  assert.ok(html.includes('&lt;img src=x'), 'escaped form must appear instead');

  const startTag = '<script type="application/json" id="proof-data">';
  const start = html.indexOf(startTag);
  assert.ok(start !== -1, 'embedded JSON payload script tag must exist');
  const bodyStart = start + startTag.length;
  const end = html.indexOf('</script>', bodyStart);
  assert.ok(end !== -1);
  const slice = html.slice(bodyStart, end);
  assert.ok(!slice.includes('</script'), 'payload must not contain a literal </script sequence');
});

test('the embedded JSON payload round-trips through JSON.parse', () => {
  const html = renderProofHtml(baseInput());
  const startTag = '<script type="application/json" id="proof-data">';
  const start = html.indexOf(startTag) + startTag.length;
  const end = html.indexOf('</script>', start);
  const slice = html.slice(start, end);
  const parsed = JSON.parse(slice);
  assert.equal(typeof parsed.frameMs, 'number');
  assert.equal(typeof parsed.lineMs, 'number');
  assert.ok(parsed.films);
});

test('each unique screenshot basename is emitted exactly once in the shot store', () => {
  const input = baseInput({
    screenshots: {
      '001-home.png': { kind: 'inline', dataUri: 'data:image/png;base64,AAAA', bytes: 10, encodedBytes: 12 },
    },
    areas: [
      {
        id: 'area-a',
        name: 'Area A',
        behaviors: [
          baseBehavior({
            frames: [
              { key: '001-home.png', caption: 'frame 1', source: 'action_trace' },
              { key: '001-home.png', caption: 'frame 1 again', source: 'action_trace' },
            ],
          }),
        ],
      },
    ],
  });
  const html = renderProofHtml(input);
  const occurrences = html.split('data:image/png;base64,').length - 1;
  assert.equal(occurrences, 1);
});

test('linked screenshots render an href, not a data URI', () => {
  const input = baseInput({
    screenshots: {
      '003.png': { kind: 'link', href: 'capture/screenshots/003.png', bytes: 999 },
    },
  });
  const html = renderProofHtml(input);
  assert.ok(html.includes('src="capture/screenshots/003.png"'));
  assert.ok(!html.includes('data:image/png;base64,'));
});

test('the page is self-contained: no external script/style/link references', () => {
  const html = renderProofHtml(baseInput());
  assert.ok(!/(?:src|href)="https?:/i.test(html));
  assert.ok(!html.includes('<link rel="stylesheet"'));
});

test('the stylesheet defines a dark-mode palette', () => {
  const html = renderProofHtml(baseInput());
  assert.ok(html.includes('prefers-color-scheme:dark'));
});

test('the progress bar segment widths sum to ~100%', () => {
  const input = baseInput({
    run: {
      timestamp: '2026-01-01T00:00:00.000Z',
      pass: false,
      summary: { total: 7, passed: 3, failed: 2, skipped: 1, untested: 1 },
    },
  });
  const html = renderProofHtml(input);
  const widths = [...html.matchAll(/progress-seg--(?:passed|failed|skipped|untested)" style="width:([\d.]+)%"/g)].map((m) =>
    Number(m[1]),
  );
  assert.equal(widths.length, 4);
  const sum = widths.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) <= 0.01, `expected ~100, got ${sum}`);
});

test('untested behaviors render badge--untested and a filmstrip note is shown escaped', () => {
  const input = baseInput({
    areas: [
      {
        id: 'area-a',
        name: 'Area A',
        behaviors: [
          baseBehavior({ status: 'untested' }),
          baseBehavior({
            id: 'area-a/behavior-b',
            filmstripNote: 'No window <derivable> & such',
          }),
        ],
      },
    ],
  });
  const html = renderProofHtml(input);
  assert.ok(html.includes('badge--untested'));
  assert.ok(html.includes('No window &lt;derivable&gt; &amp; such'));
  assert.ok(html.includes('class="film-note"'));
});
