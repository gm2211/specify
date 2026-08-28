import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductContext, buildDesignContext, renderProductMarkdown, renderDesignMarkdown } from './product-context.js';
import type { Spec } from './types.js';

function fixtureSpec(): Spec {
  return {
    version: '2',
    name: 'Demo App',
    description: 'A demo app for tests.',
    target: { type: 'web', url: 'http://localhost:3000' },
    areas: [
      {
        id: 'capture',
        name: 'Capture',
        prose: 'Capture drives a live browser to record behavior.',
        behaviors: [
          { id: 'capture-agent-generates-spec', description: 'The capture agent generates a spec from observed behavior.' },
          { id: 'capture-writes-output', description: 'Capture writes output to the requested directory.', tags: ['io'] },
        ],
      },
      {
        id: 'ui',
        name: 'User Interface',
        prose: 'The interface favors a light, minimal aesthetic.',
        behaviors: [
          { id: 'primary-button-style', description: 'The primary action uses the brand accent color.', tags: ['design', 'ui'] },
          { id: 'unrelated-behavior', description: 'Something with no design tag.' },
        ],
      },
      {
        id: 'no-prose-area',
        name: 'No Prose Area',
        behaviors: [],
      },
    ],
  };
}

test('buildProductContext includes every area and behavior, verbatim, with fully-qualified anchors', () => {
  const ctx = buildProductContext(fixtureSpec());

  assert.equal(ctx.specName, 'Demo App');
  assert.equal(ctx.areas.length, 3);

  const capture = ctx.areas.find((a) => a.areaId === 'capture')!;
  assert.equal(capture.proseClaim?.anchor, 'capture');
  assert.equal(capture.proseClaim?.text, 'Capture drives a live browser to record behavior.');
  assert.equal(capture.behaviorClaims.length, 2);
  const genSpec = capture.behaviorClaims.find((c) => c.anchor === 'capture/capture-agent-generates-spec');
  assert.ok(genSpec);
  assert.equal(genSpec!.text, 'The capture agent generates a spec from observed behavior.');

  const noProse = ctx.areas.find((a) => a.areaId === 'no-prose-area')!;
  assert.equal(noProse.proseClaim, undefined);
  assert.deepEqual(noProse.behaviorClaims, []);
});

test('renderProductMarkdown emits inline [area/behavior] anchors and never fabricates missing prose', () => {
  const md = renderProductMarkdown(buildProductContext(fixtureSpec()), 'spec.yaml');

  assert.match(md, /\[capture\/capture-agent-generates-spec\]/);
  assert.match(md, /Capture drives a live browser to record behavior\. \[capture\]/);
  assert.match(md, /## No Prose Area/);
  // No-prose area has a heading but no invented body text before the next heading.
  const noProseSection = md.split('## No Prose Area')[1].split('## ')[0];
  assert.doesNotMatch(noProseSection.trim(), /./); // nothing but whitespace/newlines
});

test('buildDesignContext includes only design-tagged behaviors, omitting untagged ones', () => {
  const ctx = buildDesignContext(fixtureSpec());

  assert.equal(ctx.constraintAreas.length, 1);
  const ui = ctx.constraintAreas[0];
  assert.equal(ui.areaId, 'ui');
  assert.equal(ui.behaviorClaims.length, 1);
  assert.equal(ui.behaviorClaims[0].anchor, 'ui/primary-button-style');
});

test('buildDesignContext omits the tokens field entirely when extraction found nothing (no fabrication)', () => {
  const ctx = buildDesignContext(fixtureSpec(), { tokens: [], sources: [] });
  assert.equal(ctx.tokens, undefined);
});

test('buildDesignContext keeps spec-derived constraints and code-derived tokens as separate, labeled fields', () => {
  const extraction = {
    tokens: [{ name: 'color.primary', value: '#0af', category: 'color' as const, source: 'tokens.json' }],
    sources: ['tokens.json'],
  };
  const ctx = buildDesignContext(fixtureSpec(), extraction);
  assert.equal(ctx.tokens?.tokens.length, 1);
  assert.equal(ctx.constraintAreas.length, 1); // unaffected by token extraction
});

test('renderDesignMarkdown labels product-constraints and visual-tokens sections separately and notes empty sources honestly', () => {
  const specWithNoDesignTags: import('./types.js').Spec = {
    ...fixtureSpec(),
    areas: [{ id: 'core', name: 'Core', behaviors: [{ id: 'x', description: 'Does a thing.' }] }],
  };

  const md = renderDesignMarkdown(buildDesignContext(specWithNoDesignTags), 'spec.yaml');

  assert.match(md, /## Product Constraints \(from spec\)/);
  assert.match(md, /## Visual Tokens \(from code\)/);
  assert.match(md, /No behaviors in the spec are tagged as design-relevant/);
  assert.match(md, /No design-token sources found/);
  // No fabricated color/style claims anywhere.
  assert.doesNotMatch(md, /#[0-9a-fA-F]{3,6}/);
});

test('renderDesignMarkdown includes anchored constraints and categorized tokens when present', () => {
  const extraction = {
    tokens: [{ name: 'color.primary', value: '#0af', category: 'color' as const, source: 'design-tokens.json' }],
    sources: ['design-tokens.json'],
  };
  const md = renderDesignMarkdown(buildDesignContext(fixtureSpec(), extraction), 'spec.yaml');

  assert.match(md, /\[ui\/primary-button-style\]/);
  assert.match(md, /### Color/);
  assert.match(md, /`color\.primary`: `#0af` _\(source: design-tokens\.json\)_/);
});
