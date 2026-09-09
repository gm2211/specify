import path from 'node:path';
import { loadSpec } from '../../spec/parser.js';
import { loadFormalManifest } from '../../model/formal-manifest.js';
import { runFormalSuite } from '../../model/formal-suite.js';
import { generateFormalTraces } from '../../model/formal-traces.js';
import { quintSpecsEnabled, quintSymbolicBackendEnabled } from '../../agent/feature-flags.js';

export async function formal(options: {
  spec: string;
  manifest?: string;
  binary?: string;
  output?: string;
  traces: boolean;
}): Promise<number> {
  try {
    if (!quintSpecsEnabled() || (!options.traces && !quintSymbolicBackendEnabled())) {
      throw new Error(
        'Formal mode requires SPECIFY_ENABLE_QUINT_SPECS=1; TLC also requires SPECIFY_ENABLE_QUINT_SYMBOLIC=1',
      );
    }
    if (!options.manifest) throw new Error('Provide --formal-manifest');
    const manifestPath = path.resolve(options.manifest);
    const spec = loadSpec(path.resolve(options.spec));
    const behaviors = new Set(
      spec.areas.flatMap((area) => area.behaviors.map((behavior) => `${area.id}/${behavior.id}`)),
    );
    const manifest = loadFormalManifest(manifestPath);
    for (const model of manifest.models) {
      if (!behaviors.has(model.behavior))
        throw new Error(`Unknown spec behavior ${model.behavior}`);
    }
    const args = {
      manifestPath,
      binary: options.binary?.includes('/')
        ? path.resolve(options.binary)
        : (options.binary ?? 'quint'),
      cwd: process.cwd(),
      output: path.resolve(
        options.output ?? (options.traces ? '.specify/formal/traces.json' : '.specify/formal'),
      ),
    };
    if (options.traces) {
      process.stdout.write(JSON.stringify(await generateFormalTraces(args)) + '\n');
      return 0;
    }
    const report = await runFormalSuite(args);
    process.stdout.write(JSON.stringify(report) + '\n');
    return report.pass ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ pass: false, error: String(error) }) + '\n');
    return 2;
  }
}
