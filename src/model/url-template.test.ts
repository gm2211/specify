import assert from 'node:assert/strict';
import test from 'node:test';
import { inferTemplates, TemplateSet } from './url-template.js';

test('REST-ish corpus: distinct param names per position', () => {
  const urls = ['/users/1', '/users/2', '/users/1/orders/99'];
  const set = inferTemplates(urls);
  const templates = set.list().map((t) => t.template);

  assert.ok(templates.includes('/users/:id'), templates.join(', '));
  assert.ok(templates.includes('/users/:id/orders/:id2'), templates.join(', '));

  const nested = set.list().find((t) => t.template === '/users/:id/orders/:id2')!;
  assert.deepEqual(nested.paramNames, ['id', 'id2']);
});

test('UUID and hex token corpus is parameterized', () => {
  const urls = [
    '/items/550e8400-e29b-41d4-a716-446655440000',
    '/items/6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    '/files/deadbeefcafebabe',
    '/files/0123456789abcdef',
  ];
  const set = inferTemplates(urls);
  const templates = set.list().map((t) => t.template);

  assert.ok(templates.includes('/items/:id'), templates.join(', '));
  assert.ok(templates.includes('/files/:id'), templates.join(', '));
});

// Word-only slugs (no digits) so they never match the id-shape heuristic —
// this isolates the distinct-value-count trigger from the id-shape trigger.
const WORD_SLUGS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
];

test('distinct-count trigger: 9 distinct slugs at a position parameterizes it', () => {
  const urls = WORD_SLUGS.map((slug) => `/blog/${slug}`);
  const set = inferTemplates(urls);
  const templates = set.list().map((t) => t.template);

  assert.deepEqual(templates, ['/blog/:id']);
});

test('below distinct-count threshold stays literal', () => {
  const urls = WORD_SLUGS.slice(0, 8).map((slug) => `/blog/${slug}`);
  const set = inferTemplates(urls);
  const templates = set.list().map((t) => t.template).sort();

  assert.equal(templates.length, 8);
  assert.ok(templates.every((t) => !t.includes(':')));
});

test('stability: shuffled input corpus yields identical templates', () => {
  const urls = [
    '/users/1',
    '/users/2',
    '/users/3',
    '/users/1/orders/99',
    '/users/2/orders/100',
    '/about',
    '/pricing',
    '/contact',
  ];
  const shuffled = [...urls].reverse();

  const a = inferTemplates(urls);
  const b = inferTemplates(shuffled);

  assert.deepEqual(a.list(), b.list());
});

test('no false positives: static marketing pages stay literal', () => {
  const urls = ['/', '/about', '/pricing', '/contact', '/careers', '/blog'];
  const set = inferTemplates(urls);
  const templates = set.list().map((t) => t.template).sort();

  assert.deepEqual(templates, ['/', '/about', '/blog', '/careers', '/contact', '/pricing']);
});

test('round-trip JSON preserves templates and match behavior', () => {
  const urls = ['/users/1', '/users/2', '/users/1/orders/99'];
  const set = inferTemplates(urls);

  const json = set.toJSON();
  const restored = TemplateSet.fromJSON(JSON.parse(JSON.stringify(json)));

  assert.deepEqual(restored.list(), set.list());
  assert.deepEqual(restored.match('/users/42'), set.match('/users/42'));
});

test('match(): correctness including trailing slash and query stripping', () => {
  const set = inferTemplates(['/users/1', '/users/2', '/users/1/orders/99']);

  const withQuery = set.match('/users/42?tab=profile#section');
  assert.ok(withQuery);
  assert.equal(withQuery!.template, '/users/:id');
  assert.deepEqual(withQuery!.params, { id: '42' });
  assert.equal(withQuery!.query, '?tab=profile');
  assert.equal(withQuery!.hash, '#section');

  const trailingSlash = set.match('/users/42/');
  assert.ok(trailingSlash);
  assert.equal(trailingSlash!.template, '/users/:id');

  const nested = set.match('/users/7/orders/123');
  assert.deepEqual(nested, { template: '/users/:id/orders/:id2', params: { id: '7', id2: '123' }, query: '', hash: '' });

  assert.equal(set.match('/nonexistent/path/here'), null);
});

test('empty path normalizes to root template', () => {
  const set = inferTemplates(['/', '', '/about']);
  assert.equal(set.match('')!.template, '/');
  assert.equal(set.match('/')!.template, '/');
});

test('templateId is stable and content-addressed', () => {
  const set = inferTemplates(['/users/1', '/users/2']);
  const id1 = set.templateId('/users/:id');
  const id2 = set.templateId('/users/:id');
  const otherSet = inferTemplates(['/orders/1', '/orders/2']);

  assert.equal(id1, id2);
  assert.notEqual(id1, otherSet.templateId('/orders/:id'));
});

test('merge() re-infers over the union of both corpora', () => {
  const a = inferTemplates(['/users/1', '/users/2']);
  const b = inferTemplates(['/users/1/orders/99']);

  const merged = a.merge(b);
  const templates = merged.list().map((t) => t.template);

  assert.ok(templates.includes('/users/:id'));
  assert.ok(templates.includes('/users/:id/orders/:id2'));
});
