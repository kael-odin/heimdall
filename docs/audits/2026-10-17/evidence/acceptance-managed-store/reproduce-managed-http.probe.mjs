import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const repo = process.cwd(), out = join(repo, 'core/workspace/_runs/managed-store-20261017/managed-http');
fs.mkdirSync(out, { recursive: true });
const testFile = join(repo, 'core/test/acceptance-managed-run-store.test.mjs');
const testBytes = fs.readFileSync(testFile), hash = value => createHash('sha256').update(value).digest('hex');
const fixtureSource = testBytes.toString('utf8').split('\ntest(')[0].replace(/from '(\.\.\/src\/[^']+)'/g,
  (_all, ref) => `from '${pathToFileURL(resolve(repo, 'core/test', ref)).href}'`) + '\nexport {fixture};\n';
const { fixture } = await import('data:text/javascript;base64,' + Buffer.from(fixtureSource).toString('base64'));
const writer = await import(pathToFileURL(join(repo, 'core/src/acceptance/managed-run-store.mjs')));
const cleanups = [], t = { after(fn) { cleanups.push(fn); } };
const save = (name, value) => fs.writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');
const files = dir => Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, hash(fs.readFileSync(join(dir, name)))]));
try {
  const f = await fixture(t);
  const preparedRequests = f.requests.length;
  writer.createManagedAcceptanceRun(f.ref, f.opts);
  const createRequests = f.requests.length;
  const raw = await f.raw(), report = writer.finishManagedAcceptanceRun(f.ref, raw, f.opts);
  const manifest = JSON.parse(fs.readFileSync(f.manifestPath));
  assert.equal(preparedRequests, 0); assert.equal(createRequests, 0);
  assert.equal(report.summary.bugs, 1); assert.equal(report.gate, 'failed'); assert.equal(manifest.status, 'completed');
  assert.equal(manifest.reportSha256, hash(fs.readFileSync(f.reportPath)));
  assert.deepEqual(files(f.sourceDir), f.originalSource);
  fs.cpSync(f.dir, join(out, 'completed-run'), { recursive: true });
  fs.cpSync(f.sourceDir, join(out, 'original-source'), { recursive: true });
  fs.copyFileSync(f.sidecar, join(out, 'prepared-record.json')); save('raw.json', raw);
  const partial = await fixture(t);
  writer.createManagedAcceptanceRun(partial.ref, partial.opts);
  const partialRaw = await partial.raw(); let failure;
  try { writer.finishManagedAcceptanceRun(partial.ref, partialRaw, { ...partial.opts, assertActive: () => !fs.existsSync(partial.reportPath) }); }
  catch (error) { failure = { code: error.code, writeMayHaveCommitted: error.writeMayHaveCommitted }; }
  assert.equal(failure?.writeMayHaveCommitted, true);
  const running = JSON.parse(fs.readFileSync(partial.manifestPath));
  assert.equal(running.status, 'running');
  const before = fs.readFileSync(partial.reportPath); save('partial-before-settle-manifest.json', running);
  const settled = writer.settleManagedAcceptanceRun(partial.ref,
    { status: 'interrupted', reasonCode: 'ENGINE_RESTARTED', error: '受控存储层中断探针，未执行引擎重启。' }, { owner: partial.owner });
  assert.equal(settled.status, 'interrupted'); assert.deepEqual(fs.readFileSync(partial.reportPath), before);
  fs.cpSync(partial.dir, join(out, 'interrupted-partial-run'), { recursive: true });
  save('summary.json', { schemaVersion: 1, evidenceLevel: 'local-http-real-runner-internal-writer',
    fixtureSource: { file: 'core/test/acceptance-managed-run-store.test.mjs', sha256: hash(testBytes) },
    executionReady: false, engineExecutorTested: false, engineRestartTested: false,
    completed: { runId: f.e.runId, taskId: f.e.taskId, preparedRequests, createRequests, runnerRequests: f.requests.length,
      status: manifest.status, gate: report.gate, bugs: report.summary.bugs, evidenceFiles: report.evidenceManifest.length,
      sourceFilesUnchanged: true, sourceFiles: f.originalSource, reportSha256: manifest.reportSha256,
      verifierFingerprint: report.verifierFingerprint },
    interruptedPartial: { runId: partial.e.runId, failure, statusBeforeSettle: running.status,
      status: settled.status, gate: settled.gate, reportBytesUnchanged: true, runnerRequests: partial.requests.length } });
  process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(join(out, 'summary.json'))), null, 2) + '\n');
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
