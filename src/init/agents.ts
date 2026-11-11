import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeManagedRegion, regionMarkers } from './managed-regions.js';

export const AGENTS_REGION = 'formal-workflow';
/** Regions written by older Specify versions; removed when the new region is installed. */
const LEGACY_REGIONS = ['intent-workflow', 'spec-workflow'];

export function agentsBody(command: string): string {
  return `## Formal properties (Specify)

OpenSpec (\`openspec/\`) holds the requirements. Specify checks the formal models linked to them and gates the work on the result.

- Link a model under the \`### Requirement:\` it encodes, one list item per check (formatters join plain lines):
  - \`- Formal: quint formal/<model>.qnt <property> [invariant|temporal] [expect=holds|fails] [backend=tlc|apalache] [main=<module>]\`
  - \`- Formal: lean formal/<File>.lean <Namespace.theorem>\`
  - \`- Formal: none (<reason>)\` waives a requirement that should not be modeled, such as pure input/output behavior.
- Paths are relative to the project root. Keep models and proofs in \`formal/\`.
- For every Quint property that must hold, link the same property on a "before" model or mutation with \`expect=fails\`, so a property that can never fail is caught.
- Write liveness as a temporal property with fairness (\`weakFair\`). TLC is the default backend and explores every reachable state within the model's constants; \`backend=apalache\` is bounded by \`max-steps\`.
- Tie each model to the code: write a conformance test that replays the traces from \`${command} trace export\` against the implementation, and name it under the requirement with \`- Verify: test <test name>\`. Specify reads the test reports listed in \`formal/specify.json\`; it does not run tests.
- Run \`${command} gate\` before finishing. Under the \`strict\` policy it fails when a check differs from its expectation, a requirement has neither a link nor a waiver, a property has no \`expect=fails\` link, a \`Verify:\` test is missing or red, or \`formal/specify.lock\` is out of date.
- After changing links or properties, run \`${command} lock\` and commit \`formal/specify.lock\`. Removing a link, flipping \`expect\` or editing a linked property needs an OpenSpec change proposal that names the requirement; never do it just to make a check pass.
- A passing check is a statement about the model only.`;
}

/** Add or update the managed region, preserving all text outside it. */
export function installAgentsRegion(target: string, body: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      // Follow a link only when it stays a regular file; never replace the link itself.
      if (!fs.statSync(target).isFile()) {
        throw new Error('Agent instruction link must point to a regular file');
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  for (const legacy of LEGACY_REGIONS) existing = removeRegion(existing, legacy);
  const { begin, end } = regionMarkers(AGENTS_REGION);
  checkMarkers(existing, AGENTS_REGION);
  const content = existing.includes(begin)
    ? mergeManagedRegion(existing, AGENTS_REGION, body).content
    : `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${begin}\n${body.trim()}\n${end}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function checkMarkers(text: string, region: string): void {
  const { begin, end } = regionMarkers(region);
  const begins = text.split(begin).length - 1;
  const ends = text.split(end).length - 1;
  if (begins !== ends || begins > 1 || (begins && text.indexOf(end) < text.indexOf(begin))) {
    throw new Error(`Malformed ${region} markers; repair instructions before initializing`);
  }
}

function removeRegion(text: string, region: string): string {
  const { begin, end } = regionMarkers(region);
  if (!text.includes(begin) && !text.includes(end)) return text;
  checkMarkers(text, region);
  const before = text.slice(0, text.indexOf(begin)).trimEnd();
  const after = text.slice(text.indexOf(end) + end.length).trimStart();
  return before && after ? `${before}\n\n${after}` : `${before}${after}`;
}
