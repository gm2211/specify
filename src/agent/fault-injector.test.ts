import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FaultInjector,
  mulberry32,
  seededDraw,
  patternMatches,
  parseFaultArg,
  isFaultType,
} from './fault-injector.js';

test('mulberry32 is deterministic for a given seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
});

test('mulberry32 differs across seeds', () => {
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notEqual(a, b);
});

test('seededDraw: same seed reproduces identical draws across independent calls', () => {
  for (let seq = 0; seq < 10; seq++) {
    assert.equal(seededDraw(7, seq), seededDraw(7, seq));
  }
});

test('seededDraw: draws vary across seq for the same seed', () => {
  const draws = new Set<number>();
  for (let seq = 0; seq < 20; seq++) draws.add(seededDraw(7, seq));
  assert.ok(draws.size > 1);
});

test('patternMatches: exact substring match without wildcard', () => {
  assert.equal(patternMatches('/api/orders', 'https://x.test/api/orders?id=1'), true);
  assert.equal(patternMatches('/api/orders', 'https://x.test/api/users'), false);
});

test('patternMatches: "*" matches everything', () => {
  assert.equal(patternMatches('*', 'https://anything.test/whatever'), true);
});

test('patternMatches: wildcard pattern', () => {
  assert.equal(patternMatches('*/api/*', 'https://x.test/v1/api/orders'), true);
  assert.equal(patternMatches('*/api/*', 'https://x.test/v1/other/orders'), false);
});

test('isFaultType: validates the fault vocabulary', () => {
  assert.equal(isFaultType('500'), true);
  assert.equal(isFaultType('timeout'), true);
  assert.equal(isFaultType('abort'), true);
  assert.equal(isFaultType('empty'), true);
  assert.equal(isFaultType('malformed'), false);
  assert.equal(isFaultType('302'), false);
});

test('parseFaultArg: parses "<urlPattern>=<type>" into a deterministic rule', () => {
  const rule = parseFaultArg('/api/orders=500');
  assert.deepEqual(rule, { urlPattern: '/api/orders', fault: '500', rate: 1.0 });
});

test('parseFaultArg: rejects malformed input', () => {
  assert.equal(parseFaultArg('no-equals-sign'), null);
  assert.equal(parseFaultArg('/api/orders=bogus'), null);
  assert.equal(parseFaultArg('=500'), null);
});

test('FaultInjector.decide: same seed reproduces identical decisions across separate injector instances', () => {
  const plan = { seed: 123, rules: [{ urlPattern: '/api/', fault: '500' as const, rate: 0.5 }] };
  const injectorA = new FaultInjector(plan);
  const injectorB = new FaultInjector({ ...plan, rules: [...plan.rules] });

  const resultsA: (boolean)[] = [];
  const resultsB: (boolean)[] = [];
  for (let seq = 0; seq < 30; seq++) {
    resultsA.push(injectorA.decide('https://x.test/api/orders', 'GET', seq) !== null);
    resultsB.push(injectorB.decide('https://x.test/api/orders', 'GET', seq) !== null);
  }
  assert.deepEqual(resultsA, resultsB);
  // Sanity: rate 0.5 shouldn't fire on literally every request.
  assert.ok(resultsA.some((r) => r === true));
  assert.ok(resultsA.some((r) => r === false));
});

test('FaultInjector.decide: rate 1.0 always fires on a match', () => {
  const injector = new FaultInjector({ seed: 1, rules: [{ urlPattern: '/api/', fault: 'abort', rate: 1.0 }] });
  for (let seq = 0; seq < 10; seq++) {
    const decision = injector.decide('https://x.test/api/orders', 'GET', seq);
    assert.equal(decision?.fault, 'abort');
  }
});

test('FaultInjector.decide: non-matching URL never fires', () => {
  const injector = new FaultInjector({ seed: 1, rules: [{ urlPattern: '/api/orders', fault: '500', rate: 1.0 }] });
  assert.equal(injector.decide('https://x.test/other/path', 'GET', 0), null);
});

test('FaultInjector.decide: method filter restricts matches', () => {
  const injector = new FaultInjector({
    seed: 1,
    rules: [{ urlPattern: '/api/orders', method: 'POST', fault: '500', rate: 1.0 }],
  });
  assert.equal(injector.decide('https://x.test/api/orders', 'GET', 0), null);
  assert.equal(injector.decide('https://x.test/api/orders', 'POST', 0)?.fault, '500');
  assert.equal(injector.decide('https://x.test/api/orders', 'post', 0)?.fault, '500');
});

test('FaultInjector: addRule/clear mutate the active plan', () => {
  const injector = new FaultInjector({ seed: 1, rules: [] });
  assert.equal(injector.isActive(), false);
  injector.addRule({ urlPattern: '/api/', fault: 'timeout', rate: 1.0 });
  assert.equal(injector.isActive(), true);
  assert.equal(injector.decide('https://x.test/api/orders', 'GET', 0)?.fault, 'timeout');
  injector.clear();
  assert.equal(injector.isActive(), false);
  assert.equal(injector.decide('https://x.test/api/orders', 'GET', 0), null);
});

test('FaultInjector.hasEverActivated: false for a rule-less session, sticky once a rule is added, survives clear()', () => {
  const injector = new FaultInjector({ seed: 1, rules: [] });
  assert.equal(injector.hasEverActivated(), false);

  injector.addRule({ urlPattern: '/api/', fault: '500', rate: 1.0 });
  assert.equal(injector.hasEverActivated(), true);

  injector.clear();
  assert.equal(injector.isActive(), false);
  assert.equal(injector.hasEverActivated(), true, 'clear() must never reset the sticky flag');
});

test('FaultInjector.hasEverActivated: true from construction when the plan has rules', () => {
  const injector = new FaultInjector({ seed: 1, rules: [{ urlPattern: '/api/', fault: 'abort', rate: 1.0 }] });
  assert.equal(injector.hasEverActivated(), true);
});

test('FaultInjector.hasEverActivated: setPlan with rules also sets the sticky flag', () => {
  const injector = new FaultInjector({ seed: 1, rules: [] });
  assert.equal(injector.hasEverActivated(), false);
  injector.setPlan({ seed: 2, rules: [{ urlPattern: '/x', fault: 'empty', rate: 1.0 }] });
  assert.equal(injector.hasEverActivated(), true);
});

test('FaultInjector.decide: first matching rule wins', () => {
  const injector = new FaultInjector({
    seed: 1,
    rules: [
      { urlPattern: '/api/', fault: '500', rate: 1.0 },
      { urlPattern: '/api/orders', fault: 'abort', rate: 1.0 },
    ],
  });
  assert.equal(injector.decide('https://x.test/api/orders', 'GET', 0)?.fault, '500');
});
