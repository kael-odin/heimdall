/**
 * Floor=Mirror 交付（E7-10）：没过门禁也交出完整的东西，且状态写得清楚
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'heimdall-deliver-'));
process.env.HEIMDALL_DATA_DIR = root;

let floor, attempts, project, activity;
const SITE = 'floor.test';

const write = (file, body) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); };

/** 一个像样的重建项目：有配置、有源码、有账本，也有不该进包的东西 */
function makeProject(name, ledger) {
  const dir = join(root, 'workspace', 'projects', name);
  write(join(dir, 'heimdall.config.json'), JSON.stringify({ schema: 'heimdall.config/1', siteId: SITE, stack: 'html-css', pages: [{ name: 'home', route: '/' }], budget: {} }));
  write(join(dir, 'index.html'), '<h1>candidate</h1>');
  write(join(dir, 'src', 'App.jsx'), 'export default () => null;\n');
  write(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  write(join(dir, '.git', 'config'), '[core]\n');
  write(join(dir, '.heimdall', 'ref', 'home', '1440.png'), 'png');
  write(join(dir, '.heimdall', 'ledger.jsonl'), ledger.map(e => JSON.stringify(e)).join('\n') + '\n');
  write(join(dir, '.env.local'), 'secret');
  write(join(dir, 'client.key'), 'secret');
  write(join(dir, '.auth', 'state.json'), 'secret');
  write(join(dir, 'nested', 'sessions', 'state.json'), 'secret');
  write(join(dir, 'cookies', 'state.json'), 'secret');
  return dir;
}

const iter = (runId, sectionId, score, verdict = 'needs-work') => ({ schema: 'heimdall.ledger/1', type: 'iter', runId, sectionIds: [sectionId], pixel: { 375: score, 768: score, 1440: score }, verdict, reached: null });

function gateFor(dir, status = 'passed') {
  const attempt = attempts.startFormalAttempt({ siteId: SITE, page: 'home', projectDir: dir, level: 'silver' });
  const gate = { ...attempt.gate, status, projectSnapshot: { schema: 'heimdall.project-snapshot/1', sha256: project.projectFingerprint(dir) } };
  attempts.writeFormalAttempt(attempt.file, gate);
  return { ...attempt, gate };
}

before(async () => {
  mkdirSync(join(root, 'workspace', SITE, 'pages', 'home', 'clone'), { recursive: true });
  write(join(root, 'workspace', SITE, 'pages', 'home', 'clone', 'index.html'), '<h1>mirror</h1>');
  write(join(root, 'workspace', SITE, 'pages', 'home', 'clone', 's.css'), 'h1{color:#000}');
  write(join(root, 'workspace', SITE, 'pages', 'home', 'clone', '.auth', 'state.json'), 'secret');
  floor = await import('../src/agent/deliver/floor.mjs');
  attempts = await import('../src/agent/gate/attempt.mjs');
  project = await import('../src/agent/deliver/project.mjs');
  activity = await import('../src/agent/activity.mjs');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('floor: state comes only from the fixed enum, and passed only from the formal gate', () => {
  const { deliveryState } = floor;
  assert.deepEqual(deliveryState({ decisions: [{ action: 'done', reason: 'pass-candidate' }] }), { state: 'failed_with_residuals', reason: 'formal_gate_missing' });
  assert.equal(deliveryState({ decisions: [{ action: 'done' }], formal: { status: 'passed' } }).state, 'passed');
  assert.equal(deliveryState({ decisions: [{ action: 'done' }, { action: 'accept-residual' }], formal: { status: 'passed' } }).state, 'passed_with_residuals');
  assert.equal(deliveryState({ decisions: [{ action: 'done' }], formal: { status: 'failed' } }).reason, 'formal_gate_failed');
  assert.equal(deliveryState({ formal: { status: 'incomplete' } }).reason, 'formal_gate_incomplete');
  assert.equal(deliveryState({ decisions: [{ action: 'stop', reason: 'budget_exhausted' }] }).state, 'budget_exhausted');
  assert.equal(deliveryState({ cancelled: true }).state, 'cancelled');
  assert.equal(deliveryState({ decisions: [] }).reason, 'no_iterations');
});

test('floor: a failed rebuild still ships mirror + report + residuals, with the project as a draft', () => {
  const projectDir = makeProject('failing', [
    iter('run_0001', 'sec-hero', 0.90), iter('run_0002', 'sec-hero', 0.94),
    iter('run_0003', 'sec-hero', 0.96), iter('run_0004', 'sec-hero', 0.965),
    iter('run_0005', 'sec-footer', 0.91),
  ]);
  const r = floor.deliverFloor({ projectDir });

  assert.equal(r.state, 'failed_with_residuals');
  assert.equal(r.reason, 'formal_gate_missing');
  assert.equal(r.floorIsMirror, true);
  assert.equal(existsSync(join(r.outDir, 'mirror', 'index.html')), true, 'the mirror is the deliverable');
  assert.equal(existsSync(join(r.outDir, 'project', 'DRAFT.md')), true, 'the project is labelled a draft');
  assert.equal(existsSync(join(r.outDir, 'project', 'src', 'App.jsx')), true);
  assert.equal(existsSync(join(r.outDir, 'project', 'node_modules')), false, 'dependencies never ship');
  assert.equal(existsSync(join(r.outDir, 'project', '.git')), false);
  assert.equal(existsSync(join(r.outDir, 'project', '.heimdall', 'ref')), false, 'reference shots are evidence, not product');
  for (const secret of ['.env.local', 'client.key', '.auth/state.json', 'nested/sessions/state.json', 'cookies/state.json']) {
    assert.equal(existsSync(join(r.outDir, 'project', secret)), false, secret);
  }
  assert.equal(existsSync(join(r.outDir, 'mirror', '.auth')), false, 'mirror login state is excluded too');

  const residuals = JSON.parse(readFileSync(join(r.outDir, 'residuals.json'), 'utf8')).residuals;
  assert.equal(residuals.length, 2);
  const hero = residuals.find(x => x.sectionId === 'sec-hero');
  assert.equal(hero.action, 'accept-residual');
  assert.equal(hero.reason, 'iteration_cap');
  assert.equal(hero.best.minPixel, 0.965, 'the worst viewport of the best run, as a number');
  assert.equal(hero.accepted, true, 'hitting the iteration cap is accepting the residual');
  const footer = residuals.find(x => x.sectionId === 'sec-footer');
  assert.equal(footer.action, 'continue');
  assert.equal(footer.accepted, false, 'a section that could still improve is an open hole');

  const report = readFileSync(join(r.outDir, 'REPORT.md'), 'utf8');
  assert.match(report, /Floor=Mirror/);
  assert.match(report, /failed_with_residuals/);
  assert.match(report, /sec-hero/, "the report shows the residual table");

  const delivery = JSON.parse(readFileSync(join(r.outDir, 'delivery.json'), 'utf8'));
  assert.equal(delivery.schema, 'heimdall.delivery/1');
  assert.equal(r.evidence.sha256.length, 64);
  const manifest = readFileSync(join(r.outDir, 'MANIFEST.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(manifest.some(m => m.path === 'delivery.json'), 'the manifest covers the machine-readable record');
  assert.ok(manifest.some(m => m.path === 'mirror/index.html'));
  assert.ok(manifest.every(m => m.sha256.length === 64));
});

test('floor: a passed rebuild ships the project without the draft marker', () => {
  const projectDir = makeProject('passing', [iter('run_0101', 'sec-hero', 0.985, 'pass-candidate')]);
  gateFor(projectDir);
  const r = floor.deliverFloor({ projectDir });
  assert.equal(r.state, 'passed');
  assert.equal(r.floorIsMirror, false);
  assert.equal(existsSync(join(r.outDir, 'project', 'DRAFT.md')), false);
  assert.match(readFileSync(join(r.outDir, 'REPORT.md'), 'utf8'), /门禁通过/);
});

test('floor: an anti-cheat hit blocks a passing delivery', () => {
  const projectDir = makeProject('cheat', [{ ...iter('run_0301', 'sec-hero', 0.99, 'pass-candidate'), anticheat: 'suspect' }]);
  gateFor(projectDir);
  const r = floor.deliverFloor({ projectDir });
  assert.equal(r.state, 'failed_with_residuals');
  assert.equal(r.reason, 'anticheat');
  assert.equal(r.floorIsMirror, true);
});

test('floor: the delivery only trusts a formal gate from the same project', () => {
  const dir = join(root, 'workspace', SITE, 'agent', 'gate', 'home');
  mkdirSync(dir, { recursive: true });
  const put = (name, gate) => writeFileSync(join(dir, name), JSON.stringify(gate));
  const mine = makeProject('mine', []);
  const other = makeProject('other', []);
  gateFor(other);
  assert.equal(floor.latestFormalGate(SITE, 'home', mine), null, 'another project is not ours');
  put('formal-b.json', { status: 'passed', level: 'silver' });
  assert.equal(floor.latestFormalGate(SITE, 'home', mine), null, 'legacy gate without projectDir is not trusted');
  put('formal-c.json', { status: 'passed', level: 'gold', projectDir: mine });
  assert.equal(floor.latestFormalGate(SITE, 'home', mine).status, 'incomplete', 'legacy gate lacks a project fingerprint');
  const gated = makeProject('gated', [iter('run_0401', 'sec-hero', 0.99, 'pass-candidate')]);
  gateFor(gated, 'failed');
  const delivered = floor.deliverFloor({ projectDir: gated });
  assert.equal(delivered.state, 'failed_with_residuals', 'a failed formal gate keeps the delivery at the floor');
});

test('floor: changed files, interrupted attempts and damaged records cannot reuse a pass', () => {
  const dir = makeProject('stale', [iter('run_0501', 'sec-hero', 0.99)]);
  const older = gateFor(dir);
  assert.equal(floor.latestFormalGate(SITE, 'home', dir).status, 'passed');
  write(join(dir, 'index.html'), '<h1>changed</h1>');
  assert.equal(floor.latestFormalGate(SITE, 'home', dir).status, 'incomplete');
  assert.equal(activity.activityOf(dir).gate.formal.status, 'incomplete');
  const delivered = floor.deliverFloor({ projectDir: dir, state: 'passed', formal: { status: 'passed' } });
  assert.equal(delivered.reason, 'formal_gate_incomplete');
  assert.match(readFileSync(join(delivered.outDir, 'project', 'DRAFT.md'), 'utf8'), /尚未完成验收/);
  const newer = attempts.startFormalAttempt({ siteId: SITE, page: 'home', projectDir: dir, level: 'silver' });
  attempts.writeFormalAttempt(older.file, older.gate);
  assert.equal(floor.latestFormalGate(SITE, 'home', dir).path, newer.file, 'a late completion cannot outrank a newer start');
  writeFileSync(newer.file, '{');
  assert.equal(floor.latestFormalGate(SITE, 'home', dir).status, 'incomplete', 'a damaged latest record cannot fall back to an old pass');
});

test('floor: secrets are relative to the project and existing output is not overwritten', () => {
  const dir = makeProject('cookies', [iter('run_0601', 'sec-hero', 0.99)]);
  gateFor(dir);
  const r = floor.deliverFloor({ projectDir: dir });
  assert.equal(r.state, 'passed');
  assert.equal(existsSync(join(r.outDir, 'project', 'index.html')), true);
  assert.throws(() => floor.deliverFloor({ projectDir: dir, outDir: r.outDir }), /必须为空/);
  assert.throws(() => floor.deliverFloor({ projectDir: dir, outDir: join(dir, 'output') }), /不能位于项目目录内/);
});

test('activity: formal, fast and delivery records do not leak across projects', () => {
  const mine = makeProject('activity-mine', [iter('run_0701', 'sec-hero', 0.99)]);
  const other = makeProject('activity-other', [iter('run_0702', 'sec-hero', 0.99)]);
  gateFor(other);
  floor.deliverFloor({ projectDir: other });
  const gateDir = join(root, 'workspace', SITE, 'agent', 'gate', 'home');
  write(join(gateDir, 'gate-other.json'), JSON.stringify({ status: 'passed', projectDir: other }));
  const snapshot = activity.activityOf(mine);
  assert.equal(snapshot.gate.formal, null);
  assert.equal(snapshot.gate.fast, null);
  assert.equal(snapshot.delivery, null);
  assert.equal(activity.activityOf(other).gate.formal.status, 'passed');
});

test('activity: real Chromium CDP shows a stale formal pass as incomplete', { timeout: 120000 }, async () => {
  const dir = makeProject('activity-cdp', [iter('run_0801', 'sec-hero', 0.99)]);
  gateFor(dir);
  const html = readFileSync(new URL('../src/agent/ui/activity.html', import.meta.url));
  const server = createServer((req, res) => {
    if (req.url === '/api/agent/projects') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ projects: [{ dir, siteId: SITE, page: 'home' }] })); }
    else if (req.url.startsWith('/api/agent/activity?')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(activity.activityOf(dir))); }
    else { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { launchBrowser } = await import('../src/agent/evidence/capture.mjs');
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('#gate .chip.pass');
    write(join(dir, 'index.html'), '<h1>updated</h1>');
    await page.click('#refresh');
    await page.waitForSelector('#gate .chip.unknown');
    const observed = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#gate").innerText', returnByValue: true });
    assert.match(observed.result.value, /未完成/);
    assert.match(observed.result.value, /项目变化或旧记录无法核验/);
    assert.equal(await page.locator('#gate .chip.pass').count(), 0);
    assert.deepEqual(errors, []);
    if (process.env.HEIMDALL_ACTIVITY_EVIDENCE_DIR) {
      mkdirSync(process.env.HEIMDALL_ACTIVITY_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.HEIMDALL_ACTIVITY_EVIDENCE_DIR, 'formal-incomplete.png'), fullPage: true });
    }
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('floor: the mirror copy can be left out for a pure project handoff', () => {
  const projectDir = makeProject('nomirror', [iter('run_0201', 'sec-hero', 0.9)]);
  const r = floor.deliverFloor({ projectDir, mirror: false });
  assert.equal(r.contents.mirror, null);
  assert.equal(existsSync(join(r.outDir, 'mirror')), false);
  assert.equal(existsSync(join(r.outDir, 'project', 'DRAFT.md')), true, 'still a draft: no formal gate yet');
});
