import { readFileSync } from 'node:fs';
import { captureIntent, getIntentContext } from '../../intent/records.js';
import { checkIntentReview, reconcileIntent } from '../../intent/review.js';
import { initializeIntent, intentWorkspace } from '../../intent/workspace.js';
import { readStdin } from '../stdin.js';
import { writeOutput } from '../output.js';
import type { CliContext } from '../types.js';

export async function intentCommand(name: string, options: Map<string, string>, ctx: CliContext) {
  const get = (key: string) => options.get(key);
  if (name === 'intent init') {
    writeOutput(initializeIntent(get('--root'), get('--pack')), ctx);
    return 0;
  }
  const workspace = intentWorkspace(get('--root'), get('--pack'));
  if (name === 'intent context') {
    writeOutput(
      await getIntentContext(workspace.packPath, {
        query: get('--query'),
        paths: get('--paths')
          ?.split(',')
          .map((entry) => entry.trim()),
      }),
      ctx,
    );
    return 0;
  }
  const input = async () => {
    const file = get('--input');
    if (!file) {
      throw new Error('Missing --input JSON file or - for stdin');
    }
    return JSON.parse(file === '-' ? await readStdin() : readFileSync(file, 'utf8')) as unknown;
  };
  if (name === 'intent capture') {
    writeOutput(await captureIntent(workspace.packPath, await input()), ctx);
    return 0;
  }
  const base = get('--base');
  if (!base) {
    throw new Error('Missing --base: use the task start commit or PR base SHA');
  }
  if (name === 'intent reconcile') {
    const result = await reconcileIntent({ ...workspace, base }, await input());
    writeOutput(result, ctx);
    return result.valid ? 0 : 1;
  }
  const result = await checkIntentReview({ ...workspace, base });
  writeOutput(result, ctx);
  return result.valid ? 0 : 1;
}
