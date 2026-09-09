/** Project-owned model declarations; execution and verdict semantics live in Specify. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const properties = {
  invariant: z.string().min(1),
  temporal: z.array(z.string().min(1)).default([]),
};
const schema = z
  .object({
    version: z.literal(1),
    quintVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    apalacheVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    tlcConfig: z.string().min(1),
    timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
    models: z
      .array(
        z
          .object({
            id,
            file: z.string().min(1),
            main: z.string().min(1),
            behavior: z.string().min(1),
            ...properties,
          })
          .strict(),
      )
      .min(1),
    controls: z
      .array(
        z
          .object({
            id,
            model: id,
            ...properties,
            replace: z
              .object({ from: z.string().min(1), to: z.string() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .default([]),
    traces: z
      .array(
        z
          .object({
            id,
            model: id,
            seed: z.number().int().nonnegative(),
            maxSteps: z.number().int().nonnegative().max(100_000),
            count: z.number().int().positive().max(10_000),
            step: z.string().min(1).default('step'),
            uniqueInitialStates: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type FormalManifest = z.infer<typeof schema>;
export function parseFormalManifest(value: unknown): FormalManifest {
  const manifest = schema.parse(value);
  const names = [...manifest.models, ...manifest.controls].map((m) => m.id);
  if (new Set(names).size !== names.length) throw new Error('Duplicate formal check id');
  const models = new Set(manifest.models.map((m) => m.id));
  for (const entry of [...manifest.controls, ...manifest.traces]) {
    if (!models.has(entry.model)) throw new Error(`Unknown model ${entry.model}`);
  }
  if (new Set(manifest.traces.map((t) => t.id)).size !== manifest.traces.length)
    throw new Error('Duplicate trace id');
  return manifest;
}
export function loadFormalManifest(file: string) {
  return parseFormalManifest(JSON.parse(readFileSync(file, 'utf8')));
}
export function manifestFile(manifestPath: string, file: string) {
  return path.resolve(path.dirname(manifestPath), file);
}
export function mutateControl(source: string, replacement?: { from: string; to: string }): string {
  if (!replacement) return source;
  if (replacement.from === replacement.to || source.split(replacement.from).length !== 2) {
    throw new Error('Negative control must change exactly one matching fragment');
  }
  return source.replace(replacement.from, replacement.to);
}
