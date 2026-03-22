import * as fs from 'fs';
import * as path from 'path';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';
import { isV1 } from '../../spec/types.js';

export interface SpecGenerateOptions {
  input: string;
  output?: string;
  name?: string;
  smart?: boolean;
  v1?: boolean;
}

export async function specGenerate(options: SpecGenerateOptions, ctx: CliContext): Promise<number> {
  const inputDir = path.resolve(options.input);
  if (!fs.existsSync(inputDir)) {
    process.stderr.write(`Input directory not found: ${inputDir}\n`);
    return ExitCode.PARSE_ERROR;
  }

  const outputFile = options.output
    ? path.resolve(options.output)
    : path.join(path.dirname(inputDir), 'spec.yaml');

  // Load traffic
  const trafficPath = path.join(inputDir, 'traffic.json');
  if (!fs.existsSync(trafficPath)) {
    process.stderr.write(`traffic.json not found in ${inputDir}\n`);
    return ExitCode.PARSE_ERROR;
  }

  // Use the existing generator module's core logic
  try {
    const { specToYaml } = await import('../../spec/parser.js');
    let spec;
    let summary: string;

    if (options.v1) {
      const { generateSpec } = await import('../../spec/generator.js');
      spec = generateSpec({
        inputDir,
        specName: options.name ?? 'Generated Spec',
        smart: options.smart ?? false,
      });
      const pageCount = isV1(spec) ? spec.pages?.length ?? 0 : 0;
      summary = `Pages: ${pageCount}`;
    } else {
      const { generateSpecV2 } = await import('../../spec/generator.js');
      spec = generateSpecV2({
        inputDir,
        specName: options.name ?? 'Generated Spec',
      });
      summary = `Version: 2.0`;
    }

    const yamlContent = specToYaml(spec);

    const dir = path.dirname(outputFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputFile, yamlContent, 'utf-8');

    if (ctx.outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ output: outputFile, format: options.v1 ? 'v1' : 'v2' }) + '\n');
    } else if (!ctx.quiet) {
      process.stdout.write(`Spec written to: ${outputFile}\n`);
      process.stdout.write(`  ${summary}\n`);
    }

    return ExitCode.SUCCESS;
  } catch (err) {
    process.stderr.write(`Generation failed: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }
}
