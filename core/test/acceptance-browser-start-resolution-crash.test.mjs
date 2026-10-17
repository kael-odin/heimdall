import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createBrowserOperationStore } from '../src/acceptance/browser-operation-store.mjs';
import { browserResolutionSha } from '../scripts/fixtures/browser-resolution-stream.mjs';

const childFile = fileURLToPath(new URL('./fixtures/acceptance-browser-start-resolution-kill-child.mjs', import.meta.url));
const vector = JSON.parse(readFileSync(new URL('./fixtures/acceptance-browser-start-resolution-vectors.json', import.meta.url))).vectors[0];
function tree(root) {
  return Object.fromEntries(readdirSync(root).sort().map(name => {
    const file = join(root, name); assert.equal(statSync(file).isFile(), true);
    const bytes = readFileSync(file); return [name, { bytes: bytes.length, sha256: browserResolutionSha(bytes) }];
  }));
}

for (const phase of ['empty', 'temporary', 'committed']) test('D4 real process crash: ' + phase + ' decision survives without guessed repair', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-resolution-crash-')));
  const input = { projectId: vector.projectId, request: vector.request }, inputFile = join(root, 'input.json'), marker = join(root, 'reached.json');
  writeFileSync(inputFile, JSON.stringify(input));
  const child = spawn(process.execPath, [childFile, root, inputFile, marker, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    rmSync(root, { recursive: true, force: true });
  });
  let timer;
  try {
    await Promise.race([exit, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Crash child did not exit: ' + output)), 15000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(readFileSync(marker, 'utf8').includes('"phase":"' + phase + '"'), true, output);
  const folder = join(root, 'browser-operations/v1', vector.request.operationId), before = tree(folder);
  const owner = acquireAcceptanceOwner({ root }), store = createBrowserOperationStore({ owner });
  try {
    if (phase === 'committed') {
      const decision = store.inspectDecision(vector.request.operationId);
      assert.equal(decision.kind, 'rejected'); assert.equal(decision.record.envelope.requestFingerprint, vector.requestFingerprint);
      const bytes = Buffer.from(decision.record.bytes);
      assert.equal(bytes.at(-1), 10); assert.equal(decision.record.sha256, browserResolutionSha(bytes));
      assert.equal(store.publishRejection(input).replayed, true);
      store.recover();
      assert.deepEqual(store.inspectDecision(vector.request.operationId).record.bytes, bytes);
      assert.equal(readdirSync(folder).includes('dispatch.json'), false);
    } else {
      assert.throws(() => store.inspectDecision(vector.request.operationId), 'A partial decision must not become absent.');
      assert.throws(() => store.publishRejection(input), 'A partial decision must not be adopted.');
      assert.throws(() => store.recover(), 'Recovery must retain partial evidence and fail closed.');
    }
    assert.deepEqual(tree(folder), before, 'Inspection/replay/recovery cannot repair or rewrite the crash scene.');
  } finally { owner.release(); }
});
