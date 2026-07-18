import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProbeOpRecord, ProbeOpType, ProbeOutcome } from './probe-workload.js';
import type { BehaviorResult, GuaranteeKind } from '../spec/types.js';
import {
  bodyContainsMarker,
  checkSessionGuarantees,
  mergeGuaranteeVerdicts,
} from './session-guarantees.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const M1 = 'specify-probe-marker-1111';
const M2 = 'specify-probe-marker-2222';

let opSeq = 0;
let clock = 0;

function resetIds(): void {
  opSeq = 0;
  clock = 0;
}

/** Build a ProbeOpRecord. opId/timestamps auto-increment in call order. */
function op(
  type: ProbeOpType,
  outcome: ProbeOutcome,
  extra: {
    entity?: string;
    marker?: string | null;
    /** Response body (reads/lists): what the target returned. */
    body?: unknown;
    status?: number;
  } = {},
): ProbeOpRecord {
  const invokeTs = clock++;
  const completeTs = clock++;
  const entity = extra.entity ?? 'user';
  const marker = 'marker' in extra ? (extra.marker ?? null) : null;
  const rec: ProbeOpRecord = {
    opId: `op-${String(++opSeq).padStart(4, '0')}`,
    type,
    entity,
    marker,
    invokeTs,
    completeTs,
    outcome,
    request: { method: 'GET', url: `http://api.test/${entity}` },
  };
  if (outcome === 'ok') {
    rec.response = {
      status: extra.status ?? 200,
      ...(extra.body !== undefined ? { body: extra.body } : {}),
    };
  } else if (outcome === 'fail') {
    rec.response = {
      status: extra.status ?? 404,
      ...(extra.body !== undefined ? { body: extra.body } : {}),
    };
    rec.error = `HTTP ${extra.status ?? 404}`;
  } else {
    rec.error = 'timeout';
  }
  return rec;
}

/** An entity object carrying a marker in its `name` field. */
function entityBody(marker: string, id = 'e1'): unknown {
  return { id, name: marker };
}

/** A list body containing zero or more marked entities. */
function listBody(...markers: string[]): unknown {
  return markers.map((m, i) => ({ id: `e${i}`, name: m }));
}

function kinds(checks: { guarantee: GuaranteeKind; verdict: string }[]): string[] {
  return checks.map((c) => `${c.guarantee}:${c.verdict}`);
}

// ---------------------------------------------------------------------------
// bodyContainsMarker
// ---------------------------------------------------------------------------

test('bodyContainsMarker finds a marker at any nesting', () => {
  resetIds();
  assert.equal(bodyContainsMarker({ name: M1 }, M1), true);
  assert.equal(bodyContainsMarker({ nested: { deep: [{ name: M1 }] } }, M1), true);
  assert.equal(bodyContainsMarker([{ name: M2 }, { name: M1 }], M1), true);
  assert.equal(bodyContainsMarker(M1, M1), true); // raw string body
  assert.equal(bodyContainsMarker({ name: M2 }, M1), false);
  assert.equal(bodyContainsMarker(undefined, M1), false);
  assert.equal(bodyContainsMarker(null, M1), false);
});

// ---------------------------------------------------------------------------
// read-your-writes
// ---------------------------------------------------------------------------

test('read-your-writes holds: ok create then ok read reflecting the marker', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M1) }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.deepEqual(kinds(report.checks), ['read-your-writes:holds']);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.summary.holds, 1);
});

test('read-your-writes violated: ok create then ok read MISSING the marker (seeded bug)', () => {
  resetIds();
  const create = op('create', 'ok', { marker: M1, body: entityBody(M1) });
  const read = op('read', 'ok', { marker: M1, body: entityBody(M2) }); // stale — wrong marker
  const report = checkSessionGuarantees([create, read]);

  assert.equal(report.anomalies.length, 1);
  const anomaly = report.anomalies[0];
  assert.equal(anomaly.guarantee, 'read-your-writes');
  assert.equal(anomaly.verdict, 'violated');
  // Witness chain carries the exact ops, markers, timestamps.
  assert.deepEqual(
    anomaly.witness.map((w) => w.opId),
    [create.opId, read.opId],
  );
  assert.equal(anomaly.witness[0].marker, M1);
  assert.equal(anomaly.witness[0].ts, create.completeTs);
  assert.equal(anomaly.witness[1].ts, read.completeTs);
  assert.match(anomaly.detail, new RegExp(M1));
});

test('read-your-writes inconclusive: indeterminate create widens acceptable outcomes', () => {
  resetIds();
  const ops = [
    op('create', 'indeterminate', { marker: M1 }),
    op('read', 'ok', { marker: M1, body: entityBody(M2) }), // "wrong" but create may not have applied
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.summary.inconclusive, 1);
  assert.equal(report.checks[0].verdict, 'inconclusive');
  assert.match(report.checks[0].inconclusiveReason ?? '', /indeterminate/);
});

test('read-your-writes inconclusive: a non-2xx read carries no marker evidence', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'fail', { marker: M1, status: 500 }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.checks[0].verdict, 'inconclusive');
});

test('read-your-writes inconclusive: a timed-out read carries no marker evidence', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'indeterminate', { marker: M1 }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.summary.inconclusive, 1);
  assert.equal(report.anomalies.length, 0);
});

test('read-your-writes after ok update reflects the NEW marker', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M1) }),
    op('update', 'ok', { marker: M2, body: entityBody(M2) }),
    op('read', 'ok', { marker: M2, body: entityBody(M2) }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.summary.holds, 2);
});

// ---------------------------------------------------------------------------
// monotonic-reads
// ---------------------------------------------------------------------------

test('monotonic-reads violated: a marker observed then lost by a later ok read', () => {
  resetIds();
  const create = op('create', 'ok', { marker: M1, body: entityBody(M1) });
  const read1 = op('read', 'ok', { marker: M1, body: entityBody(M1) }); // observed
  const read2 = op('read', 'ok', { marker: M1, body: entityBody(M2) }); // regressed
  const report = checkSessionGuarantees([create, read1, read2]);

  assert.equal(report.summary.holds, 1);
  assert.equal(report.anomalies.length, 1);
  assert.equal(report.anomalies[0].guarantee, 'monotonic-reads');
  assert.match(report.anomalies[0].detail, /regression/);
});

test('monotonic inconclusive: an intervening indeterminate write makes a later read undecidable', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M1) }),
    op('update', 'indeterminate', { marker: M2 }),
    op('read', 'ok', { marker: M2, body: entityBody(M1) }), // could legitimately show old or new
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.summary.inconclusive, 1);
});

// ---------------------------------------------------------------------------
// no-resurrection
// ---------------------------------------------------------------------------

test('no-resurrection holds: ok delete then ok read without the marker', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('delete', 'ok', { marker: M1 }),
    op('read', 'ok', { marker: M1, body: {} }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  const resurrection = report.checks.filter((c) => c.guarantee === 'no-resurrection');
  assert.equal(resurrection.length, 1);
  assert.equal(resurrection[0].verdict, 'holds');
});

test('no-resurrection violated: deleted marker reappears in a later ok list', () => {
  resetIds();
  const create = op('create', 'ok', { marker: M1, body: entityBody(M1) });
  const del = op('delete', 'ok', { marker: M1 });
  const list = op('list', 'ok', { marker: M1, body: listBody(M1) });
  const report = checkSessionGuarantees([create, del, list]);

  assert.equal(report.anomalies.length, 1);
  assert.equal(report.anomalies[0].guarantee, 'no-resurrection');
  assert.deepEqual(
    report.anomalies[0].witness.map((w) => w.opId),
    [del.opId, list.opId],
  );
});

test('no-resurrection inconclusive: an indeterminate delete leaves the entity possibly-present', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('delete', 'indeterminate', { marker: M1 }),
    op('read', 'ok', { marker: M1, body: entityBody(M1) }), // present, but delete may not have applied
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.summary.inconclusive, 1);
});

// ---------------------------------------------------------------------------
// create-appears-in-list + tolerance
// ---------------------------------------------------------------------------

test('create-appears-in-list holds: ok create then ok list containing the marker', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('list', 'ok', { marker: M1, body: listBody('other', M1) }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.checks[0].guarantee, 'create-appears-in-list');
  assert.equal(report.checks[0].verdict, 'holds');
});

test('create-appears-in-list violated: marker absent from list beyond tolerance', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('list', 'ok', { marker: M1, body: listBody('other') }),
  ];
  const report = checkSessionGuarantees(ops, { toleranceMs: 0 });
  assert.equal(report.anomalies.length, 1);
  assert.equal(report.anomalies[0].guarantee, 'create-appears-in-list');
});

test('create-appears-in-list clean within eventual-consistency window: inconclusive with tolerance noted', () => {
  resetIds();
  const create = op('create', 'ok', { marker: M1, body: entityBody(M1) });
  const list = op('list', 'ok', { marker: M1, body: listBody('other') }); // completeTs is 3, create completeTs is 1
  const report = checkSessionGuarantees([create, list], { toleranceMs: 1000 });

  assert.equal(report.anomalies.length, 0);
  const check = report.checks.find((c) => c.guarantee === 'create-appears-in-list');
  assert.ok(check);
  assert.equal(check.verdict, 'inconclusive');
  assert.match(check.toleranceNote ?? '', /tolerance 1000ms/);
  assert.match(check.inconclusiveReason ?? '', /tolerance/);
});

test('list miss beyond the window is still a violation even with tolerance set', () => {
  resetIds();
  const create = op('create', 'ok', { marker: M1, body: entityBody(M1) });
  // Manually push the list far past the window.
  const list = op('list', 'ok', { marker: M1, body: listBody('other') });
  list.completeTs = create.completeTs + 5000;
  const report = checkSessionGuarantees([create, list], { toleranceMs: 1000 });
  assert.equal(report.anomalies.length, 1);
});

// ---------------------------------------------------------------------------
// Entities without markers / grouping
// ---------------------------------------------------------------------------

test('entities with no marker field yield no guarantee checks', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: null, body: { id: 'x' } }),
    op('read', 'ok', { marker: null, body: { id: 'x' } }),
    op('delete', 'ok', { marker: null }),
    op('read', 'fail', { marker: null }),
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.checks.length, 0);
});

test('checks are grouped per entity (independent sessions)', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { entity: 'user', marker: M1, body: entityBody(M1) }),
    op('create', 'ok', { entity: 'order', marker: M2, body: entityBody(M2) }),
    op('read', 'ok', { entity: 'user', marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { entity: 'order', marker: M2, body: entityBody(M1) }), // order read misses its own marker
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.anomalies.length, 1);
  assert.equal(report.anomalies[0].entity, 'order');
});

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

test('report exposes per-guarantee counts and explicit non-claims', () => {
  resetIds();
  const ops = [
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M2) }), // RYW violation
  ];
  const report = checkSessionGuarantees(ops);
  assert.equal(report.summary.byGuarantee['read-your-writes'].violated, 1);
  assert.equal(report.summary.byGuarantee['monotonic-reads'].violated, 0);
  assert.ok(report.nonClaims.some((n) => /isolation-level/i.test(n)));
  assert.ok(report.nonClaims.some((n) => /Indeterminate/i.test(n)));
});

// ---------------------------------------------------------------------------
// Binding into verify-result (asymmetric merge)
// ---------------------------------------------------------------------------

function behavior(id: string, status: BehaviorResult['status']): BehaviorResult {
  return { id, description: id, status };
}

test('merge: a violated bound guarantee forces the behavior to failed', () => {
  resetIds();
  const report = checkSessionGuarantees([
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M2) }),
  ]);
  const output = { results: [behavior('data/consistency', 'passed')] };
  const merged = mergeGuaranteeVerdicts(output, report, {
    bindings: new Map([['data/consistency', 'all']]),
  }) as {
    output: { results: BehaviorResult[] };
    guaranteeForcedFailures: string[];
    checksAttached: number;
  };

  const r = merged.output.results[0];
  assert.equal(r.status, 'failed');
  assert.equal(r.guarantee_source, 'guarantee');
  assert.deepEqual(merged.guaranteeForcedFailures, ['data/consistency']);
  assert.ok(r.guarantees && r.guarantees.length === 1);
  assert.match(r.rationale ?? '', /\[guarantee\]/);
});

test('merge: all-holds guarantees corroborate an LLM pass', () => {
  resetIds();
  const report = checkSessionGuarantees([
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M1) }),
  ]);
  const output = { results: [behavior('data/consistency', 'passed')] };
  const merged = mergeGuaranteeVerdicts(output, report, {
    bindings: new Map([['data/consistency', 'all']]),
  }) as { output: { results: BehaviorResult[] } };
  assert.equal(merged.output.results[0].status, 'passed');
  assert.equal(merged.output.results[0].guarantee_source, 'guarantee+llm');
});

test('merge: inconclusive-only guarantees never flip status', () => {
  resetIds();
  const report = checkSessionGuarantees([
    op('create', 'indeterminate', { marker: M1 }),
    op('read', 'ok', { marker: M1, body: entityBody(M2) }),
  ]);
  const output = { results: [behavior('data/consistency', 'passed')] };
  const merged = mergeGuaranteeVerdicts(output, report, {
    bindings: new Map([['data/consistency', 'all']]),
  }) as { output: { results: BehaviorResult[] } };
  assert.equal(merged.output.results[0].status, 'passed');
  assert.equal(merged.output.results[0].guarantee_source, 'llm');
});

test('merge: a satisfied guarantee never overturns an LLM fail', () => {
  resetIds();
  const report = checkSessionGuarantees([
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M1) }),
  ]);
  const output = { results: [behavior('data/consistency', 'failed')] };
  const merged = mergeGuaranteeVerdicts(output, report, {
    bindings: new Map([['data/consistency', 'all']]),
  }) as { output: { results: BehaviorResult[] } };
  assert.equal(merged.output.results[0].status, 'failed');
  assert.equal(merged.output.results[0].guarantee_source, 'llm');
});

test('merge: bindings can restrict to specific guarantee kinds', () => {
  resetIds();
  // A no-resurrection violation, but the behavior only binds read-your-writes.
  const report = checkSessionGuarantees([
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('delete', 'ok', { marker: M1 }),
    op('list', 'ok', { marker: M1, body: listBody(M1) }),
  ]);
  const output = { results: [behavior('data/consistency', 'passed')] };
  const merged = mergeGuaranteeVerdicts(output, report, {
    bindings: new Map<string, GuaranteeKind[]>([['data/consistency', ['read-your-writes']]]),
  }) as { output: { results: BehaviorResult[] }; checksAttached: number };
  // The no-resurrection anomaly is not bound, so status is untouched.
  assert.equal(merged.output.results[0].status, 'passed');
  assert.equal(merged.checksAttached, 0);
});

test('merge: behaviors not in the binding map are left untouched (by reference)', () => {
  resetIds();
  const report = checkSessionGuarantees([
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M2) }),
  ]);
  const output = { results: [behavior('unrelated/behavior', 'passed')] };
  const merged = mergeGuaranteeVerdicts(output, report, {
    bindings: new Map([['data/consistency', 'all']]),
  });
  assert.equal(merged.output, output); // identical by reference — noop
});

test('merge: emits a violation event per anomaly', () => {
  resetIds();
  const report = checkSessionGuarantees([
    op('create', 'ok', { marker: M1, body: entityBody(M1) }),
    op('read', 'ok', { marker: M1, body: entityBody(M2) }),
  ]);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  mergeGuaranteeVerdicts({ results: [behavior('data/consistency', 'passed')] }, report, {
    bindings: new Map([['data/consistency', 'all']]),
    emit: (type, data) => events.push({ type, data }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'guarantee:violation');
  assert.equal(events[0].data.guarantee, 'read-your-writes');
});
