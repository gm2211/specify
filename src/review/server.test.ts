import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { listFormulas, setFormulaStatus, startReviewServer } from './server.js';
import {
  addDraft,
  defaultFormulasPath,
  emptyFormulasFile,
  hashDescription,
  loadFormulas,
  saveFormulas,
} from '../spec/formulas.js';
import { eventually, pred } from '../monitor/formula.js';
import {
  defaultFormulaStatsPath,
  emptyFormulaStatsFile,
  recordFormulaVerdict,
  saveFormulaStats,
  PROMOTION_STREAK,
} from '../monitor/formula-stats.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specify-review-server-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeSpecFile(specPath: string): void {
  const yaml = [
    'version: "2"',
    'name: "Test Spec"',
    'target:',
    '  type: web',
    '  url: http://localhost:3000',
    'areas:',
    '  - id: auth',
    '    name: Auth',
    '    behaviors:',
    '      - id: login',
    '        description: "User can log in with valid credentials"',
  ].join('\n') + '\n';
  fs.writeFileSync(specPath, yaml, 'utf-8');
}

function writeFormulasFile(formulasPath: string): { id: string } {
  const formula = eventually(pred('http.response', ['/api/login', '200']));
  const { file, entry } = addDraft(emptyFormulasFile(), {
    behavior: 'auth/login',
    formula,
    description_hash: hashDescription('User can log in with valid credentials'),
    predicates_used: ['http.response'],
    provenance: { compiled_by: 'test', compiled_at: '2026-01-01T00:00:00Z' },
  });
  saveFormulas(formulasPath, file);
  return { id: entry.id };
}

test('listFormulas joins each entry with its behavior description, pretty formula, and witnesses', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    writeFormulasFile(defaultFormulasPath(specPath));

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas.length, 1);
    const [entry] = formulas;
    assert.equal(entry.behavior, 'auth/login');
    assert.equal(entry.behaviorDescription, 'User can log in with valid credentials');
    assert.ok(entry.prettyFormula.includes('pred:http.response'));
    assert.ok(entry.witnesses.accepting.length >= 1);
    assert.ok(entry.witnesses.rejecting.length >= 1);
    assert.equal(entry.status, 'draft');
  } finally {
    cleanup();
  }
});

test('listFormulas: no stats file yet -> stats null, all flags false', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    writeFormulasFile(defaultFormulasPath(specPath));

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas[0].stats, null);
    assert.equal(formulas[0].promotionSuggested, false);
    assert.equal(formulas[0].driftFlagged, false);
    assert.equal(formulas[0].recompileFlagged, false);
  } finally {
    cleanup();
  }
});

test('listFormulas: surfaces a promotion suggestion once a draft formula crosses the agreement streak', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { id } = writeFormulasFile(defaultFormulasPath(specPath));

    let statsFile = emptyFormulaStatsFile();
    for (let i = 0; i < PROMOTION_STREAK; i++) {
      statsFile = recordFormulaVerdict(statsFile, {
        formulaId: id,
        formulaStatus: 'draft',
        verdict: 'satisfied',
        llmStatus: 'passed',
        vacuous: false,
      }).file;
    }
    saveFormulaStats(defaultFormulaStatsPath(specPath), statsFile);

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas[0].promotionSuggested, true);
    assert.equal(formulas[0].stats?.agreements, PROMOTION_STREAK);
  } finally {
    cleanup();
  }
});

test('listFormulas: recompileFlagged only surfaces for approved formulas, not drafts', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const formulasPath = defaultFormulasPath(specPath);
    const { id } = writeFormulasFile(formulasPath);

    const statsFile = recordFormulaVerdict(emptyFormulaStatsFile(), {
      formulaId: id,
      formulaStatus: 'approved',
      verdict: 'satisfied',
      llmStatus: 'failed',
      vacuous: false,
    }).file;
    saveFormulaStats(defaultFormulaStatsPath(specPath), statsFile);

    // Still draft: the flag is tallied in stats but not surfaced as
    // recompileFlagged until the formula is actually approved.
    const { formulas: whileDraft } = await listFormulas(specPath);
    assert.equal(whileDraft[0].recompileFlagged, false);
    assert.equal(whileDraft[0].stats?.recompileFlagged, true, 'still recorded in the raw stats row');

    // Approve it: now the same stats row should surface as recompileFlagged.
    const result = setFormulaStatus(specPath, id, 'approved');
    assert.ok('ok' in result);
    const { formulas: whileApproved } = await listFormulas(specPath);
    assert.equal(whileApproved[0].recompileFlagged, true);
  } finally {
    cleanup();
  }
});

test('listFormulas returns an empty list when no formulas file exists yet', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { formulas } = await listFormulas(specPath);
    assert.deepEqual(formulas, []);
  } finally {
    cleanup();
  }
});

test('setFormulaStatus("approved") flips status and it survives a reload', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { id } = writeFormulasFile(defaultFormulasPath(specPath));

    const result = setFormulaStatus(specPath, id, 'approved');
    assert.deepEqual(result, { ok: true, id, status: 'approved' });

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas[0].status, 'approved');
  } finally {
    cleanup();
  }
});

test('setFormulaStatus("rejected") is preserved across subsequent lists', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const { id } = writeFormulasFile(defaultFormulasPath(specPath));

    setFormulaStatus(specPath, id, 'rejected');
    const first = await listFormulas(specPath);
    assert.equal(first.formulas[0].status, 'rejected');

    // A second, unrelated read should still see the rejection.
    const second = await listFormulas(specPath);
    assert.equal(second.formulas[0].status, 'rejected');
  } finally {
    cleanup();
  }
});

test('setFormulaStatus does not clobber a concurrent write that lands between load and save', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const formulasPath = defaultFormulasPath(specPath);
    const { id } = writeFormulasFile(formulasPath);

    // Simulate a concurrent writer (e.g. spec-compile appending a draft via
    // addDraft) landing on disk in the window between setFormulaStatus's
    // initial load and its write, using the onLoadedForTest seam.
    const result = setFormulaStatus(specPath, id, 'approved', () => {
      const existing = loadFormulas(formulasPath)!;
      const { file: withConcurrentDraft } = addDraft(existing, {
        behavior: 'auth/login',
        formula: eventually(pred('http.response', ['/api/login', '500'])),
        description_hash: hashDescription('User can log in with valid credentials'),
        predicates_used: ['http.response'],
        provenance: { compiled_by: 'concurrent-writer', compiled_at: '2026-01-01T00:00:01Z' },
      });
      saveFormulas(formulasPath, withConcurrentDraft);
    });

    assert.deepEqual(result, { ok: true, id, status: 'approved' });

    const { formulas } = await listFormulas(specPath);
    assert.equal(formulas.length, 2, 'the concurrently-added draft must survive the status write');
    const approved = formulas.find((f) => f.id === id);
    assert.equal(approved?.status, 'approved');
    assert.ok(
      formulas.some((f) => f.provenance.compiled_by === 'concurrent-writer'),
      'the concurrent draft must not have been clobbered',
    );
  } finally {
    cleanup();
  }
});

test('setFormulaStatus returns conflict (no throw, no clobber) when a concurrent write corrupts the file', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const formulasPath = defaultFormulasPath(specPath);
    const { id } = writeFormulasFile(formulasPath);

    const corruptedYaml = 'version: 1\npredicates_version: 1\nformulas: [ {{ not yaml\n';
    const result = setFormulaStatus(specPath, id, 'approved', () => {
      fs.writeFileSync(formulasPath, corruptedYaml, 'utf-8');
    });

    assert.ok('error' in result && result.error === 'conflict', 'expected a conflict error result');
    assert.match((result as { error: 'conflict'; message: string }).message, /could not be reloaded/);
    // The corrupted on-disk content must be left untouched, not overwritten
    // with the handler's stale in-memory copy.
    assert.equal(fs.readFileSync(formulasPath, 'utf-8'), corruptedYaml);
  } finally {
    cleanup();
  }
});

test('setFormulaStatus reports not_found (no throw) when a concurrent write deletes the file', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    const formulasPath = defaultFormulasPath(specPath);
    const { id } = writeFormulasFile(formulasPath);

    const result = setFormulaStatus(specPath, id, 'approved', () => {
      fs.rmSync(formulasPath);
    });

    assert.deepEqual(result, { error: 'not_found' });
    assert.equal(fs.existsSync(formulasPath), false, 'the deleted file must not be resurrected');
  } finally {
    cleanup();
  }
});

test('setFormulaStatus reports not_found for an unknown id', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.yaml');
    writeSpecFile(specPath);
    writeFormulasFile(defaultFormulasPath(specPath));

    const result = setFormulaStatus(specPath, 'fml-doesnotexist', 'approved');
    assert.deepEqual(result, { error: 'not_found' });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SP-q50: the review server's HTTP API is unauthenticated, so it must bind
// loopback-only (127.0.0.1) by default rather than every interface — see
// startReviewServer()'s ServeOptions.host in ./server.ts.
// ---------------------------------------------------------------------------

function pickServerPort(): number {
  return 4200 + Math.floor(Math.random() * 4000);
}

function getRequest(port: number, urlPath: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: buf }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForReviewServerUp(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await getRequest(port, '/api/spec');
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`review server never came up on port ${port}: ${String(lastErr)}`);
}

test('startReviewServer defaults to loopback-only (127.0.0.1) when no host option is given', async (t) => {
  const { dir, cleanup } = tmpDir();
  const specPath = path.join(dir, 'spec.yaml');
  writeSpecFile(specPath);
  const port = pickServerPort();

  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const serverPromise = startReviewServer({ specPath, port, open: false });

  t.after(async () => {
    process.stderr.write = originalWrite;
    process.kill(process.pid, 'SIGTERM');
    try { await serverPromise; } catch { /* ignore */ }
    cleanup();
  });

  await waitForReviewServerUp(port);
  const res = await getRequest(port, '/api/spec');
  assert.equal(res.status, 200);

  const banner = stderrChunks.join('');
  assert.match(banner, /Server:\s+http:\/\/127\.0\.0\.1:/,
    'server should report binding to loopback (127.0.0.1), not a wider interface');
});

test('startReviewServer honors an explicit host option', async (t) => {
  const { dir, cleanup } = tmpDir();
  const specPath = path.join(dir, 'spec.yaml');
  writeSpecFile(specPath);
  const port = pickServerPort();

  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const serverPromise = startReviewServer({ specPath, port, open: false, host: '127.0.0.1' });

  t.after(async () => {
    process.stderr.write = originalWrite;
    process.kill(process.pid, 'SIGTERM');
    try { await serverPromise; } catch { /* ignore */ }
    cleanup();
  });

  await waitForReviewServerUp(port);
  const banner = stderrChunks.join('');
  assert.match(banner, /Server:\s+http:\/\/127\.0\.0\.1:/);
});
