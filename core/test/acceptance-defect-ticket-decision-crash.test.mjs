/** Actual killed processes, preserved disk scenes, and a fresh owner/store per restart. */
import test, { after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createDefectTicketStore } from '../src/acceptance/defect-ticket-store.mjs';
import { defectTicketRequestFingerprint, defectTicketMemberSetDigest, defectTicketDecisionBytes } from '../src/acceptance/defect-ticket-schema.mjs';

const uid = (prefix, n) => `${prefix}-00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(value).digest('hex'), h = value => sha(Buffer.from(value));
const childFile = fileURLToPath(new URL('./fixtures/acceptance-defect-ticket-decision-kill-child.mjs', import.meta.url));
// 默认放系统临时目录、跑完清掉；只有设了 D6_CRASH_EVIDENCE_ROOT 才留盘（收集证据用）。理由同 d5 store 测试：
// 旧默认值相对「当前工作目录」，pnpm test 从 core/ 跑就会写出 core/core/workspace/。
const keepEvidence = Boolean(process.env.D6_CRASH_EVIDENCE_ROOT);
const evidenceRoot = keepEvidence ? resolve(process.env.D6_CRASH_EVIDENCE_ROOT) : mkdtempSync(join(tmpdir(), 'heimdall-d6-crash-'));
mkdirSync(evidenceRoot, { recursive: true });
if (!keepEvidence) afterAll(() => { try { rmSync(evidenceRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 清理失败不该让测试变红 */ } });
function decisions() {
  const request = { ticketId: uid('dt', 1), actionId: uid('da', 1), sourceOperationId: uid('bo', 1), memberCheckIds: ['desktop'],
    title: 'Menu is missing', severity: 'high', description: 'Menu panel is absent.', reproduction: 'Open menu and observe.' };
  const original = { version: 1, projectId: uid('ap', 1), ticketId: request.ticketId, kind: 'create', actionId: request.actionId,
    requestFingerprint: defectTicketRequestFingerprint({ projectId: uid('ap', 1), ticketId: request.ticketId, kind: 'create', request }), request };
  const member = { checkId: 'desktop', bugId: 'bug-' + h('bug'), route: '/', identity: { version: 1, kind: 'browser', facet: 'visual',
    caseKey: h('case'), contextKey: h('context'), ruleKey: h('rule'), oracleKey: h('oracle'), environmentKey: h('environment'),
    viewport: { width: 960, height: 640 } }, verifierFingerprint: h('verifier'),
  evidence: [{ role: 'targetScreenshot', file: 'target.png', bytes: 17, sha256: h('image') }] };
  const event = { ticketContractVersion: 1, kind: 'create', ticketId: request.ticketId, actionId: request.actionId,
    projectId: original.projectId, candidateId: uid('bc', 1), contentDigest: h('content'), revision: 0,
    previousEventSha256: null, requestFingerprint: original.requestFingerprint, createdAt: '2026-10-18T00:00:00.000Z', actor: { kind: 'local-operator' },
    title: request.title, severity: request.severity, description: request.description, reproduction: request.reproduction,
    source: { operationId: request.sourceOperationId, targetReleaseId: uid('ar', 1), acceptedAt: '2026-10-17T23:00:00.000Z',
      recordedAt: '2026-10-17T23:01:00.000Z', dispatchSha256: h('dispatch'), reportSha256: h('report'), observationsSha256: h('observations') },
    members: [member], memberSetDigest: defectTicketMemberSetDigest([member]) };
  return { event, rejection: { actionDecisionVersion: 1, kind: 'manual-defect-ticket-action-rejection', original,
    effect: 'deny-late-manual-defect-ticket-action', decidedAt: '2026-10-18T01:00:00.000Z', actor: { kind: 'local-operator' } } };
}
function tree(root) {
  const result = {};
  function visit(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name), relative = prefix + name, stat = lstatSync(path);
      if (stat.isDirectory()) { result[relative + '/'] = { directory: true }; visit(path, relative + '/'); }
      else { assert.equal(stat.isFile(), true); const bytes = readFileSync(path);
        result[relative] = { bytes: bytes.length, sha256: sha(bytes), nlink: stat.nlink, ino: stat.ino }; }
    }
  }
  visit(root); return result;
}

for (const kind of ['event', 'rejection']) for (const phase of ['namespace-parent', 'namespace-version', 'temporary', 'before-link', 'linked', 'committed'])
  test(`D6 real process crash preserves ${kind} at ${phase} without guessed repair`, async t => {
    const root = realpathSync(mkdtempSync(join(evidenceRoot, `${kind}-${phase}-`))), value = decisions(), input = { [kind]: value[kind] };
    const inputFile = join(root, 'input.json'), marker = join(root, 'reached.json'); writeFileSync(inputFile, JSON.stringify(input) + '\n');
    const child = spawn(process.execPath, [childFile, root, inputFile, marker, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const exit = once(child, 'exit'); let timer;
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } });
    try { await Promise.race([exit, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Crash child did not exit: ' + output)), 15000); })]); }
    finally { clearTimeout(timer); writeFileSync(join(root, 'child-output.log'), output); }
    assert.notEqual(child.exitCode, 0, output); const reached = JSON.parse(readFileSync(marker));
    assert.equal(reached.phase, phase); assert.equal(reached.kind, kind);
    if (phase.startsWith('namespace-')) assert.deepEqual(reached.names, []);
    else if (phase === 'committed') assert.deepEqual(reached.names, [value.event.actionId + '.json']);
    else {
      const temporary = reached.names.filter(name => /^\.defect-ticket-[a-f0-9-]+\.tmp$/.test(name));
      assert.equal(temporary.length, 1);
      assert.deepEqual(reached.names, phase === 'linked' ? [...temporary, value.event.actionId + '.json'].sort() : temporary);
    }
    const parent = join(root, 'defect-tickets'), before = tree(parent); writeFileSync(join(root, 'scene-before.json'), JSON.stringify(before, null, 2) + '\n');
    const owner = acquireAcceptanceOwner({ root }), store = createDefectTicketStore({ owner });
    const scope = value.event, args = { projectId: scope.projectId, actionId: scope.actionId, requestFingerprint: scope.requestFingerprint };
    try {
      if (phase === 'committed') {
        const record = store.action(scope.projectId, scope.actionId), expected = defectTicketDecisionBytes(value[kind]);
        assert.equal(record.sha256, sha(expected)); assert.deepEqual(record[kind], value[kind]);
        for (const method of ['append', 'deny']) {
          const result = await store[method]({ ...args, prepare() { throw Error('Committed proof must bypass preparation'); } });
          assert.equal(result.replayed, true); assert.deepEqual(result.record, record);
        }
        assert.equal(store.snapshot(scope.projectId).records.length, kind === 'event' ? 1 : 0);
      } else {
        assert.throws(() => store.action(scope.projectId, scope.actionId), { code: 'INTEGRITY_BLOCKED' });
        assert.throws(() => store.snapshot(scope.projectId), { code: 'INTEGRITY_BLOCKED' });
        for (const method of ['append', 'deny']) await assert.rejects(store[method]({ ...args, prepare() { throw Error('Partial scenes must not be prepared'); } }), { code: 'INTEGRITY_BLOCKED' });
      }
      assert.deepEqual(tree(parent), before, 'Fresh inspection and replay preserve every original name, inode, byte and link count.');
    } finally { owner.release(); }
    writeFileSync(join(root, 'scene-after.json'), JSON.stringify(tree(parent), null, 2) + '\n');
    t.diagnostic(JSON.stringify({ phase, kind, root, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
  });
