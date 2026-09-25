import type {
  ActionTraceEntry,
  BehaviorResult,
  Evidence,
  GuaranteeCheck,
  MonitorVerdict,
  Spec,
  VerificationReport,
} from '../spec/types.js';

export interface ExternalResultError {
  path: string;
  message: string;
}

export type ExternalResultsSummary = VerificationReport['summary'] & {
  /** Contract behaviors absent from the supplied results. */
  untested: number;
};

export type ExternalResultsValidation =
  | {
      valid: true;
      /** False when any contract behavior has no result. Skipped is counted separately. */
      complete: boolean;
      missingIds: string[];
      summary: ExternalResultsSummary;
      /** Normalized report; input pass/summary/spec metadata are never trusted. */
      report: VerificationReport;
    }
  | { valid: false; errors: ExternalResultError[] };

const STATUS = new Set(['passed', 'failed', 'skipped']);
const EVIDENCE_TYPE = new Set(['screenshot', 'text', 'network_log', 'command_output', 'file']);
const TRACE_TYPE = new Set([
  'navigation',
  'click',
  'fill',
  'screenshot',
  'observation',
  'assertion',
  'wait',
  'other',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  errors: ExternalResultError[],
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  errors.push({ path: `${path}/${key}`, message: 'must be a string' });
  return undefined;
}

function readEvidence(
  value: unknown,
  path: string,
  errors: ExternalResultError[],
): Evidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array' });
    return undefined;
  }
  const evidence: Evidence[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    const entry = record(item);
    if (!entry) {
      errors.push({ path: itemPath, message: 'must be an object' });
      return;
    }
    if (!EVIDENCE_TYPE.has(entry.type as string)) {
      errors.push({ path: `${itemPath}/type`, message: 'invalid evidence type' });
    }
    if (typeof entry.label !== 'string') {
      errors.push({ path: `${itemPath}/label`, message: 'must be a string' });
    }
    if (typeof entry.content !== 'string') {
      errors.push({ path: `${itemPath}/content`, message: 'must be a string' });
    }
    if (
      EVIDENCE_TYPE.has(entry.type as string) &&
      typeof entry.label === 'string' &&
      typeof entry.content === 'string'
    ) {
      evidence.push({
        type: entry.type as Evidence['type'],
        label: entry.label,
        content: entry.content,
      });
    }
  });
  return evidence;
}

function readTrace(
  value: unknown,
  path: string,
  errors: ExternalResultError[],
): ActionTraceEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'must be an array' });
    return undefined;
  }
  const trace: ActionTraceEntry[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}/${index}`;
    const entry = record(item);
    if (!entry) {
      errors.push({ path: itemPath, message: 'must be an object' });
      return;
    }
    if (!TRACE_TYPE.has(entry.type as string)) {
      errors.push({ path: `${itemPath}/type`, message: 'invalid trace type' });
    }
    if (typeof entry.description !== 'string') {
      errors.push({ path: `${itemPath}/description`, message: 'must be a string' });
    }
    const screenshot = optionalString(entry, 'screenshot', itemPath, errors);
    const timestamp = optionalString(entry, 'timestamp', itemPath, errors);
    if (TRACE_TYPE.has(entry.type as string) && typeof entry.description === 'string') {
      trace.push({
        type: entry.type as ActionTraceEntry['type'],
        description: entry.description,
        ...(screenshot === undefined ? {} : { screenshot }),
        ...(timestamp === undefined ? {} : { timestamp }),
      });
    }
  });
  return trace;
}

function rejectRecordedMetadata(
  entry: Record<string, unknown>,
  path: string,
  errors: ExternalResultError[],
): Partial<BehaviorResult> {
  if (entry.repro !== undefined) {
    errors.push({
      path: `${path}/repro`,
      message: 'external results cannot assert runner reproduction',
    });
  }
  if (entry.monitor !== undefined || entry.verdict_source !== undefined) {
    errors.push({ path, message: 'external results cannot assert monitor verdicts' });
  }
  if (entry.guarantees !== undefined || entry.guarantee_source !== undefined) {
    errors.push({ path, message: 'external results cannot assert session guarantees' });
  }
  return {};
}

function readRecordedMetadata(
  entry: Record<string, unknown>,
  path: string,
  errors: ExternalResultError[],
): Partial<BehaviorResult> {
  const recorded: Partial<BehaviorResult> = {};
  if (entry.repro !== undefined) {
    const repro = record(entry.repro);
    if (!repro || typeof repro.confirmed !== 'boolean' || typeof repro.output !== 'string') {
      errors.push({
        path: `${path}/repro`,
        message: 'must contain confirmed boolean and output string',
      });
    } else {
      const test = optionalString(repro, 'test', `${path}/repro`, errors);
      recorded.repro = {
        confirmed: repro.confirmed,
        output: repro.output,
        ...(test === undefined ? {} : { test }),
      };
    }
  }
  if (entry.monitor !== undefined) {
    if (
      !Array.isArray(entry.monitor) ||
      !entry.monitor.every(
        (item) =>
          record(item) &&
          typeof item.formula_id === 'string' &&
          ['draft', 'approved'].includes(item.status) &&
          ['satisfied', 'violated', 'inconclusive', 'unevaluable'].includes(item.verdict) &&
          typeof item.trace_length === 'number' &&
          Number.isFinite(item.trace_length),
      )
    ) {
      errors.push({ path: `${path}/monitor`, message: 'must be an array of monitor verdicts' });
    } else {
      recorded.monitor = entry.monitor as MonitorVerdict[];
    }
  }
  if (entry.verdict_source !== undefined) {
    if (['monitor', 'llm', 'monitor+llm'].includes(entry.verdict_source as string)) {
      recorded.verdict_source = entry.verdict_source as BehaviorResult['verdict_source'];
    } else {
      errors.push({ path: `${path}/verdict_source`, message: 'invalid verdict source' });
    }
  }
  if (entry.guarantees !== undefined) {
    if (
      !Array.isArray(entry.guarantees) ||
      !entry.guarantees.every(
        (item) =>
          record(item) &&
          typeof item.guarantee === 'string' &&
          typeof item.entity === 'string' &&
          ['holds', 'violated', 'inconclusive'].includes(item.verdict) &&
          Array.isArray(item.witness) &&
          typeof item.detail === 'string',
      )
    ) {
      errors.push({ path: `${path}/guarantees`, message: 'must be an array of guarantee checks' });
    } else {
      recorded.guarantees = entry.guarantees as GuaranteeCheck[];
    }
  }
  if (entry.guarantee_source !== undefined) {
    if (['guarantee', 'llm', 'guarantee+llm'].includes(entry.guarantee_source as string)) {
      recorded.guarantee_source = entry.guarantee_source as BehaviorResult['guarantee_source'];
    } else {
      errors.push({ path: `${path}/guarantee_source`, message: 'invalid guarantee source' });
    }
  }
  return recorded;
}

/**
 * Validate a result supplied by another agent/test runner against a contract.
 * This is deliberately separate from the permissive reader for historical
 * `verify-result.json` archives used by `specify prove`.
 */
export function validateExternalResults(spec: Spec, raw: unknown): ExternalResultsValidation {
  return validateResults(spec, raw, false);
}

/** Read older verify bundles while retaining their recorded runner metadata. */
export function validateArchivedResults(spec: Spec, raw: unknown): ExternalResultsValidation {
  return validateResults(spec, raw, true);
}

function validateResults(
  spec: Spec,
  raw: unknown,
  allowRecordedMetadata: boolean,
): ExternalResultsValidation {
  const errors: ExternalResultError[] = [];
  const outer = record(raw);
  const data = outer && 'structuredOutput' in outer ? record(outer.structuredOutput) : outer;
  if (!data) return { valid: false, errors: [{ path: '/', message: 'must be a result object' }] };
  if (!Array.isArray(data.results)) {
    return { valid: false, errors: [{ path: '/results', message: 'must be an array' }] };
  }
  if (data.timestamp !== undefined && typeof data.timestamp !== 'string') {
    errors.push({ path: '/timestamp', message: 'must be a string' });
  }

  const contract = new Map<string, string>();
  const areaIds = new Set<string>();
  for (const area of spec.areas) {
    if (areaIds.has(area.id)) {
      errors.push({ path: '/spec/areas', message: `duplicate contract area ID: ${area.id}` });
    }
    areaIds.add(area.id);
    for (const behavior of area.behaviors) {
      const id = `${area.id}/${behavior.id}`;
      if (contract.has(id)) {
        errors.push({ path: '/spec/areas', message: `duplicate contract behavior ID: ${id}` });
      } else {
        contract.set(id, behavior.description);
      }
    }
  }
  if (contract.size === 0) {
    errors.push({ path: '/spec/areas', message: 'contract must contain at least one behavior' });
  }
  if (errors.length > 0) return { valid: false, errors };
  const seen = new Set<string>();
  const results: BehaviorResult[] = [];
  data.results.forEach((item, index) => {
    const itemPath = `/results/${index}`;
    const entry = record(item);
    if (!entry) {
      errors.push({ path: itemPath, message: 'must be an object' });
      return;
    }
    const id = entry.id;
    if (typeof id !== 'string' || !contract.has(id)) {
      errors.push({ path: `${itemPath}/id`, message: 'must be a known area/behavior ID' });
    } else if (seen.has(id)) {
      errors.push({ path: `${itemPath}/id`, message: `duplicate behavior ID: ${id}` });
    } else {
      seen.add(id);
    }
    if (!STATUS.has(entry.status as string)) {
      errors.push({ path: `${itemPath}/status`, message: 'must be passed, failed, or skipped' });
    }
    optionalString(entry, 'description', itemPath, errors);
    // The ID is stable; prose may have changed since this run. Render the
    // current contract description while accepting a historical string.
    const method = optionalString(entry, 'method', itemPath, errors);
    const rationale = optionalString(entry, 'rationale', itemPath, errors);
    const evidence = readEvidence(entry.evidence, `${itemPath}/evidence`, errors);
    const actionTrace = readTrace(entry.action_trace, `${itemPath}/action_trace`, errors);
    let duration: number | undefined;
    if (entry.duration_ms !== undefined) {
      if (
        typeof entry.duration_ms === 'number' &&
        Number.isFinite(entry.duration_ms) &&
        entry.duration_ms >= 0
      ) {
        duration = entry.duration_ms;
      } else {
        errors.push({ path: `${itemPath}/duration_ms`, message: 'must be a nonnegative number' });
      }
    }
    const recorded = allowRecordedMetadata
      ? readRecordedMetadata(entry, itemPath, errors)
      : rejectRecordedMetadata(entry, itemPath, errors);
    if (typeof id === 'string' && contract.has(id) && STATUS.has(entry.status as string)) {
      results.push({
        id,
        description: contract.get(id)!,
        status: entry.status as BehaviorResult['status'],
        ...(method === undefined ? {} : { method }),
        ...(rationale === undefined ? {} : { rationale }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(actionTrace === undefined ? {} : { action_trace: actionTrace }),
        ...(duration === undefined ? {} : { duration_ms: duration }),
        ...recorded,
      });
    }
  });
  if (errors.length > 0) return { valid: false, errors };

  const missingIds = [...contract.keys()].filter((id) => !seen.has(id));
  const summary: ExternalResultsSummary = {
    total: contract.size,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    untested: missingIds.length,
  };
  const complete = missingIds.length === 0;
  const report: VerificationReport = {
    spec: { name: spec.name, version: spec.version },
    timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
    pass: complete && summary.failed === 0 && summary.skipped === 0,
    summary: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
    },
    results,
  };
  return { valid: true, complete, missingIds, summary, report };
}
