/** Seeded trace artifacts reuse Specify's ITF decoder and subprocess boundary.
 * These are simulation evidence, never proof or approval of a drafted model. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFormalManifest, manifestFile } from './formal-manifest.js';
import { sha256, toolVersion, type SuiteOptions } from './formal-suite.js';
import { spawnQuint } from './quint-runner.js';
import { parseItfJson, type ItfState } from './quint-itf.js';
export async function generateFormalTraces(options: SuiteOptions) {
  const manifest = loadFormalManifest(options.manifestPath);
  if (!manifest.traces.length) throw new Error('No trace declarations');
  const quint = await toolVersion(options, manifest.quintVersion);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-traces-'));
  const entries: {
    model: string;
    source: string;
    sha256: string;
    seed: number;
    traces: ItfState[][];
  }[] = [];
  try {
    for (const entry of manifest.traces) {
      const model = manifest.models.find((m) => m.id === entry.model)!;
      const source = manifestFile(options.manifestPath, model.file);
      const result = await (options.exec ?? spawnQuint)(
        [
          options.binary,
          'run',
          source,
          '--main',
          model.main,
          '--backend',
          'typescript',
          '--seed',
          String(entry.seed),
          '--max-samples',
          String(entry.count),
          '--n-traces',
          String(entry.count),
          '--step',
          entry.step,
          '--max-steps',
          String(entry.maxSteps),
          '--out-itf',
          path.join(scratch, `${entry.id}-{seq}.itf.json`),
        ],
        { cwd: scratch, timeoutMs: manifest.timeoutMs },
      );
      if (
        result.code !== 0 ||
        result.spawnError ||
        result.stdoutTruncated ||
        result.stderrTruncated
      )
        throw new Error(`Simulation failed: ${result.spawnError ?? result.stderr}`);
      let traces = Array.from({ length: entry.count }, (_, index) => {
        const decoded = parseItfJson(
          fs.readFileSync(path.join(scratch, `${entry.id}-${index}.itf.json`), 'utf8'),
        );
        if (decoded.errors.length || !decoded.trace.states.length)
          throw new Error(`Invalid ITF: ${decoded.errors.join('; ')}`);
        return decoded.trace.states.filter(
          (state, i, all) => i === 0 || JSON.stringify(state) !== JSON.stringify(all[i - 1]),
        );
      });
      if (entry.uniqueInitialStates !== undefined) {
        traces = [...new Map(traces.map((trace) => [JSON.stringify(trace[0]), trace])).values()];
        if (traces.length !== entry.uniqueInitialStates)
          throw new Error(
            `Expected ${entry.uniqueInitialStates} unique initial states for ${entry.id}; got ${traces.length}`,
          );
      }
      entries.push({
        model: entry.id,
        source: entry.model,
        sha256: sha256(fs.readFileSync(source, 'utf8')),
        seed: entry.seed,
        traces,
      });
    }
    const corpus = { quint, entries };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(corpus) + '\n');
    return {
      kind: 'simulation',
      traces: entries.reduce((n, entry) => n + entry.traces.length, 0),
      output: options.output,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
