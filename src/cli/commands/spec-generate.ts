import * as fs from 'fs';
import * as path from 'path';
import type { CliContext } from '../types.js';
import { ExitCode } from '../exit-codes.js';

export interface SpecGenerateOptions {
  input: string;
  output?: string;
  name?: string;
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
    const { generateSpec } = await import('../../spec/generator.js');
    const spec = generateSpec({
      inputDir,
      specName: options.name ?? 'Generated Spec',
    });

    const yamlContent = specToYaml(spec);

    const dir = path.dirname(outputFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputFile, yamlContent, 'utf-8');

    if (ctx.outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ output: outputFile }) + '\n');
    } else if (!ctx.quiet) {
      process.stdout.write(`Spec written to: ${outputFile}\n`);
    }

    return ExitCode.SUCCESS;
  } catch (err) {
    process.stderr.write(`Generation failed: ${(err as Error).message}\n`);
    return ExitCode.PARSE_ERROR;
  }
}
