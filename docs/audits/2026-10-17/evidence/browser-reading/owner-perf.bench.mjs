import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

const repo = process.cwd(), out = fileURLToPath(new URL('.', import.meta.url));
const moduleUrl = pathToFileURL(join(repo, 'core/src/acceptance/owner.mjs'));
const oldText = execFileSync('git', ['show', 'HEAD:core/src/acceptance/owner.mjs'], { cwd: repo, encoding: 'utf8' });
const oldCode = oldText.replace(/from '([^']+)'/g, (full, specifier) => specifier.startsWith('.')
  ? 'from ' + JSON.stringify(new URL(specifier, moduleUrl).href) : full);
const oldModule = await import('data:text/javascript;base64,' + Buffer.from(oldCode).toString('base64'));
const newModule = await import(moduleUrl);
const { managedExecutionFixture } = await import(pathToFileURL(join(repo, 'core/scripts/fixtures/managed-execution.mjs')));
const { createAcceptanceReadScope, captureAcceptanceRunHead } = await import(pathToFileURL(join(repo, 'core/src/acceptance/managed-run-reader.mjs')));
const { createManagedSpecDispatchReadContext } = await import(pathToFileURL(join(repo, 'core/src/acceptance/managed-dispatch-reader.mjs')));
const { readAcceptanceSnapshot } = await import(pathToFileURL(join(repo, 'core/src/acceptance/store.mjs')));

const fixture = await managedExecutionFixture({ paths: ['/healthy', '/bug'] });
let runId, rawRoot;
try {
  const engine = await fixture.startEngine();
  const accepted = await engine.execute(fixture.confirmation());
  assert.equal(accepted.status, 202);
  runId = accepted.body.runId;
  await engine.waitRun(runId);
  await engine.waitTask(accepted.body.taskId, 'done');
  await engine.stop();
  rawRoot = join(out, 'raw-managed-material');
  fs.cpSync(fixture.root, rawRoot, { recursive: true, filter: path => basename(path) !== newModule.ACCEPTANCE_OWNER_FILE });
} finally { await fixture.cleanup(); }

const roots = { old: join(out, 'old-owner-root'), hardened: join(out, 'hardened-owner-root') };
for (const root of Object.values(roots)) fs.cpSync(rawRoot, root, { recursive: true });
const owners = { old: oldModule.acquireAcceptanceOwner({ root: roots.old }), hardened: newModule.acquireAcceptanceOwner({ root: roots.hardened }) };
const contexts = Object.fromEntries(Object.entries(roots).map(([label, root]) => [label, createManagedSpecDispatchReadContext({ root })]));
const headRead = label => {
  const scope = createAcceptanceReadScope({ root: roots[label] });
  const head = captureAcceptanceRunHead(runId, { scope });
  assert.equal(head.kind, 'managed');
  scope.assertCurrent();
};
const snapshotRead = label => {
  const result = readAcceptanceSnapshot(runId, { root: roots[label] });
  assert.equal(result.integrity.valid, true);
};
const cases = {
  'owner.assertOwned': { batch: 100, rounds: 60, call: label => owners[label].assertOwned() },
  'managedHead.ownerFree': { batch: 1, rounds: 40, call: headRead },
  'managedHead.withTwoOwnerChecks': { batch: 1, rounds: 40, call: label => { owners[label].assertOwned(); headRead(label); owners[label].assertOwned(); } },
  'managedSnapshot.ownerFree': { batch: 1, rounds: 25, call: snapshotRead },
  'managedDispatch.withOwnerCheck': { batch: 1, rounds: 40, call: label => { owners[label].assertOwned(); contexts[label].assertCurrent(); } },
};
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { samples: values.length, minMs: sorted[0], medianMs: at(.5), p95Ms: at(.95), maxMs: sorted.at(-1), meanMs: values.reduce((a, b) => a + b, 0) / values.length };
};
const measurements = {};
try {
  for (const [name, item] of Object.entries(cases)) {
    for (let warm = 0; warm < 6; warm++) for (const label of ['old', 'hardened']) item.call(label);
    const samples = { old: [], hardened: [] };
    for (let round = 0; round < item.rounds; round++) {
      for (const label of round % 2 ? ['hardened', 'old'] : ['old', 'hardened']) {
        const start = performance.now();
        for (let i = 0; i < item.batch; i++) item.call(label);
        samples[label].push((performance.now() - start) / item.batch);
      }
    }
    measurements[name] = { old: stats(samples.old), hardened: stats(samples.hardened) };
    measurements[name].medianDeltaMs = measurements[name].hardened.medianMs - measurements[name].old.medianMs;
    console.log(JSON.stringify({ name, ...measurements[name] }));
  }
  const originals = {}, counts = {};
  for (const name of ['realpathSync', 'lstatSync', 'readFileSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']) {
    originals[name] = fs.default[name];
    fs.default[name] = function(...args) { counts[name] = (counts[name] ?? 0) + 1; return Reflect.apply(originals[name], this, args); };
  }
  syncBuiltinESMExports();
  const calls = {};
  try {
    for (const label of ['old', 'hardened']) {
      for (const key of Object.keys(counts)) delete counts[key];
      owners[label].assertOwned(); calls[label] = { ...counts };
    }
    for (const key of Object.keys(counts)) delete counts[key];
    headRead('hardened'); calls.managedHeadOwnerFree = { ...counts };
  } finally {
    for (const [name, original] of Object.entries(originals)) fs.default[name] = original;
    syncBuiltinESMExports();
  }
  const result = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    oldOwnerSource: 'git HEAD:core/src/acceptance/owner.mjs', hardenedOwnerSource: moduleUrl.href,
    fixture: { runId, rawRoot, paths: ['/healthy', '/bug'], requests: 2 }, measurements, nativeCallCounts: calls,
    limits: 'Quiet local interleaved microbenchmarks, no whole-suite load. Managed public readers are owner-free; combined cases model added guards rather than claiming a production route.' };
  fs.writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('result=' + join(out, 'result.json'));
} finally { owners.old.release(); owners.hardened.release(); }
