import fs from 'node:fs';
import path from 'node:path';
import { scanOpenSpec } from './openspec.js';
import { runProcess } from './process.js';

const TRACE_START = /^(State \d+:|\[State \d+\])/;
const TRACE_END =
  /^(\d+ states generated|Finished |Trace exploration|\[violation\]|\[ok\]|error:|Use --)/;
const MAX_TRACE_LINES = 60;

/** The counterexample states a Quint run printed (TLC, Apalache or the simulator), if any. */
export function extractCounterexample(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => TRACE_START.test(line.trim()));
  if (start === -1) return undefined;
  const trace: string[] = [];
  for (const line of lines.slice(start)) {
    if (TRACE_END.test(line.trim())) break;
    trace.push(line.trimEnd());
  }
  while (trace.length && !trace.at(-1)) trace.pop();
  if (trace.length > MAX_TRACE_LINES) {
    const more = trace.length - MAX_TRACE_LINES;
    return [...trace.slice(0, MAX_TRACE_LINES), `… ${more} more lines`].join('\n');
  }
  return trace.join('\n');
}

export interface TraceExportOptions {
  root: string;
  /** Output directory relative to the root (default `formal/traces`). */
  out?: string;
  traces?: number;
  maxSteps?: number;
  seed?: number;
  quintBin?: string;
  timeoutMs?: number;
}

export interface TraceExport {
  file: string;
  main?: string;
  directory: string;
  traces: string[];
  error?: string;
}

/**
 * Write ITF traces of every Quint model that a requirement expects to hold, for conformance tests
 * to replay against the implementation. Traces are sampled with a fixed seed and stripped of
 * timestamps, so the files are reproducible and can be committed.
 */
export async function exportTraces(options: TraceExportOptions): Promise<TraceExport[]> {
  const root = path.resolve(options.root);
  const out = path.resolve(root, options.out ?? path.join('formal', 'traces'));
  const traces = options.traces ?? 10;
  const models = new Map<string, { file: string; main?: string }>();
  for (const ref of scanOpenSpec(root).references) {
    const check = ref.check;
    if (check?.tool !== 'quint' || check.expect !== 'holds') continue;
    models.set(`${check.file}\n${check.main ?? ''}`, { file: check.file, main: check.main });
  }
  const exported: TraceExport[] = [];
  for (const model of models.values()) {
    const name = model.main ?? path.basename(model.file).replace(/\.qnt$/, '');
    const directory = path.join(out, name);
    fs.mkdirSync(directory, { recursive: true });
    for (const stale of fs.readdirSync(directory)) {
      if (/^trace-\d+\.itf\.json$/.test(stale)) fs.rmSync(path.join(directory, stale));
    }
    const result = await runProcess(
      options.quintBin ?? 'quint',
      [
        'run',
        path.resolve(root, model.file),
        '--backend',
        'typescript',
        '--max-samples',
        String(traces),
        '--n-traces',
        String(traces),
        '--max-steps',
        String(options.maxSteps ?? 20),
        '--seed',
        String(options.seed ?? 1),
        '--out-itf',
        path.join(directory, 'trace-{seq}.itf.json'),
        ...(model.main ? ['--main', model.main] : []),
      ],
      { cwd: root, timeoutMs: options.timeoutMs ?? 120_000 },
    );
    const written = fs
      .readdirSync(directory)
      .filter((entry) => /^trace-\d+\.itf\.json$/.test(entry))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const entry of written) normalizeItf(path.join(directory, entry), model.file);
    const relative = (target: string): string =>
      path.relative(root, target).split(path.sep).join('/');
    exported.push({
      ...model,
      directory: relative(directory),
      traces: written.map((entry) => relative(path.join(directory, entry))),
      ...(result.exitCode === 0 && written.length
        ? {}
        : { error: result.message ?? (result.stderr.trim() || 'Quint wrote no traces') }),
    });
  }
  return exported;
}

/** Drop the timestamp and description so the same seed always yields the same file. */
function normalizeItf(file: string, source: string): void {
  const itf = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  itf['#meta'] = { format: 'ITF', source };
  fs.writeFileSync(file, JSON.stringify(itf) + '\n');
}
