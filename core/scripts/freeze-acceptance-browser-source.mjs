#!/usr/bin/env node
/** Explicitly freeze new browser-source test material; existing evidence is never overwritten. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAcceptanceRun, acceptanceRunDir, finishAcceptanceRun, readAcceptanceSnapshot } from '../src/acceptance/store.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { startAcceptanceFixture } from '../test/fixtures/acceptance-site.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const point = (id, route) => ({ id, title: `展开菜单 ${id}`, route,
  steps: [{ action: 'click', selector: '#menu-toggle' }],
  assertions: [{ kind: 'visible', selector: '#menu' },
    { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' }] });

/** Browser collection is explicit; test imports do not launch a browser or bind a port. */
export async function freezeAcceptanceBrowserSource(destination) {
  const target = resolve(destination);
  await mkdir(target); // exclusive by design, including after an interrupted generation
  const runtimeRelative = 'core/workspace/_runs/browser-source-freeze-' + Date.now();
  const runtime = resolve(REPO_ROOT, runtimeRelative);
  await mkdir(runtime, { recursive: true });
  const fixture = await startAcceptanceFixture();
  try {
    const routes = ['/visual-shift?revision=one', '/identical?revision=two'];
    const matrix = { name: 'Browser source matrix', mode: 'regression',
      baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl, routes,
      viewports: [{ name: 'desktop', width: 960, height: 640 }, { name: 'mobile', width: 375, height: 812 }],
      points: [point('shift-menu', routes[0]), point('identical-menu', routes[1])], timeoutMs: 10000, settleMs: 50 };
    const single = { ...matrix, routes: ['/identical'], viewports: [matrix.viewports[0]], points: [] };
    const plans = [
      { id: 'matrix', description: 'Two healthy sides differ visually; two routes, two viewports, two declared behavior points.', plan: matrix },
      { id: 'target-unavailable', description: 'Healthy baseline; target cannot navigate and has null screenshot roles.',
        plan: { ...single, targetUrl: 'http://127.0.0.1:1/unavailable' } },
      { id: 'baseline-unavailable', description: 'Healthy target; baseline cannot navigate and has null screenshot roles.',
        plan: { ...single, baselineUrl: 'http://127.0.0.1:1/unavailable' } },
      { id: 'assertion-failed', description: 'Healthy page and capture, but declared point assertion is false on both sides.',
        plan: { ...single, points: [{ ...point('false-menu', '/identical'),
          assertions: [{ kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'false' }] }] } },
    ];
    const samples = [];
    for (const { id, description, plan } of plans) {
      const initial = createAcceptanceRun(plan, { root: runtime });
      const runDir = acceptanceRunDir(initial.runId, runtime);
      const raw = await runAcceptance(initial.plan, { runId: initial.runId, outputDir: runDir });
      const report = finishAcceptanceRun(initial.runId, raw, { root: runtime });
      const manifestBytes = await readFile(join(runDir, 'manifest.json'));
      const reportBytes = await readFile(join(runDir, 'report.json'));
      const names = [...new Set(report.checks.flatMap(check => Object.values(check.evidence ?? {}))
        .filter(file => typeof file === 'string'))].sort();
      const indexed = new Map(report.evidenceManifest.map(entry => [entry.file, entry]));
      const output = join(target, id);
      await mkdir(output);
      const copied = [];
      for (const file of ['manifest.json', 'report.json', ...names]) {
        const bytes = file === 'manifest.json' ? manifestBytes : file === 'report.json' ? reportBytes : await readFile(join(runDir, file));
        if (indexed.has(file)) {
          assert.equal(indexed.get(file).bytes, bytes.length);
          assert.equal(indexed.get(file).sha256, sha(bytes));
        }
        await writeFile(join(output, file), bytes, { flag: 'wx' });
        copied.push({ file, bytes: bytes.length, sha256: sha(bytes) });
      }
      // This is a byte-material handoff, independent of the legacy reader's null-role rejection.
      // Every non-null report reference above has been read and compared with its completion index.
      const integrity = { valid: true, evidenceVerified: true, errors: [], verifiedFiles: names.length,
        verifiedBytes: names.reduce((sum, file) => sum + indexed.get(file).bytes, 0), reportSha256: sha(reportBytes) };
      await writeFile(join(output, 'integrity.json'), json(integrity), { flag: 'wx' });
      const legacyIntegrity = readAcceptanceSnapshot(initial.runId, { root: runtime }).integrity;
      if (id === 'matrix') { assert.equal(report.checks.length, 28); assert.equal(report.gate, 'failed'); assert.equal(legacyIntegrity.valid, true); }
      samples.push({ id, description, runId: initial.runId, gate: report.gate, declaredChecks: report.checks.length,
        verifierFingerprint: report.verifierFingerprint, reportSha256: sha(reportBytes), files: copied,
        legacyReaderValid: legacyIntegrity.valid, legacyReaderErrors: legacyIntegrity.errors });
      console.log(JSON.stringify({ sample: id, checks: report.checks.length, gate: report.gate, files: copied.length }));
    }
    const index = { schemaVersion: 1, kind: 'frozen-real-browser-source-material', generatedAt: new Date().toISOString(),
      generator: 'core/scripts/freeze-acceptance-browser-source.mjs', fixture: 'core/test/fixtures/acceptance-site.mjs',
      runtime: runtimeRelative, origin: fixture.baselineUrl.replace(/\/baseline$/, ''),
      integrityHandoff: 'integrity.json is independently reconstructed from all non-null report references and exact completion bytes. The legacy reader rejects null evidence values on an unavailable side. No raw manifest, report or evidence bytes are rewritten.',
      limitations: 'Local deterministic fixture only; no external deployment, authentication, complete query redirect chain, ownership or reusable execution proof.', samples };
    await writeFile(join(target, 'source-index.json'), json(index), { flag: 'wx' });
    return index;
  } finally { await fixture.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Supply a NEW output directory; existing material is never overwritten.');
  await freezeAcceptanceBrowserSource(process.argv[2]);
}
