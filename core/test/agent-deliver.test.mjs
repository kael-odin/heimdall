/**
 * Floor=Mirror 交付（E7-10）：没过门禁也交出完整的东西，且状态写得清楚
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'heimdall-deliver-'));
process.env.HEIMDALL_DATA_DIR = root;

let floor;
const SITE = 'floor.test';

const write = (file, body) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); };

/** 一个像样的重建项目：有配置、有源码、有账本，也有不该进包的东西 */
function makeProject(name, ledger) {
  const dir = join(root, 'projects', name);
  write(join(dir, 'heimdall.config.json'), JSON.stringify({ schema: 'heimdall.config/1', siteId: SITE, stack: 'html-css', pages: [{ name: 'home', route: '/' }], budget: {} }));
  write(join(dir, 'index.html'), '<h1>candidate</h1>');
  write(join(dir, 'src', 'App.jsx'), 'export default () => null;\n');
  write(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  write(join(dir, '.git', 'config'), '[core]\n');
  write(join(dir, '.heimdall', 'ref', 'home', '1440.png'), 'png');
  write(join(dir, '.heimdall', 'ledger.jsonl'), ledger.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

const iter = (runId, sectionId, score, verdict = 'needs-work') => ({ schema: 'heimdall.ledger/1', type: 'iter', runId, sectionIds: [sectionId], pixel: { 375: score, 768: score, 1440: score }, verdict, reached: null });

before(async () => {
  mkdirSync(join(root, 'workspace', SITE, 'pages', 'home', 'clone'), { recursive: true });
  write(join(root, 'workspace', SITE, 'pages', 'home', 'clone', 'index.html'), '<h1>mirror</h1>');
  write(join(root, 'workspace', SITE, 'pages', 'home', 'clone', 's.css'), 'h1{color:#000}');
  floor = await import('../src/agent/deliver/floor.mjs');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('floor: state comes only from the fixed enum, and passed only from the formal gate', () => {
  const { deliveryState } = floor;
  assert.deepEqual(deliveryState({ decisions: [{ action: 'done', reason: 'pass-candidate' }] }), { state: 'failed_with_residuals', reason: 'formal_gate_missing' });
  assert.equal(deliveryState({ decisions: [{ action: 'done' }], formal: { status: 'passed' } }).state, 'passed');
  assert.equal(deliveryState({ decisions: [{ action: 'done' }, { action: 'accept-residual' }], formal: { status: 'passed' } }).state, 'passed_with_residuals');
  assert.equal(deliveryState({ decisions: [{ action: 'done' }], formal: { status: 'failed' } }).reason, 'formal_gate_failed');
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
  const r = floor.deliverFloor({ projectDir, formal: { status: 'passed' } });
  assert.equal(r.state, 'passed');
  assert.equal(r.floorIsMirror, false);
  assert.equal(existsSync(join(r.outDir, 'project', 'DRAFT.md')), false);
  assert.match(readFileSync(join(r.outDir, 'REPORT.md'), 'utf8'), /门禁通过/);
});

test('floor: an anti-cheat hit blocks a passing delivery', () => {
  const projectDir = makeProject('cheat', [{ ...iter('run_0301', 'sec-hero', 0.99, 'pass-candidate'), anticheat: 'suspect' }]);
  const r = floor.deliverFloor({ projectDir, formal: { status: 'passed' } });
  assert.equal(r.state, 'failed_with_residuals');
  assert.equal(r.reason, 'anticheat');
  assert.equal(r.floorIsMirror, true);
});

test('floor: the delivery only trusts a formal gate from the same project', () => {
  const site = 'floor.test';
  const dir = join(root, 'workspace', site, 'agent', 'gate', 'home');
  mkdirSync(dir, { recursive: true });
  const put = (name, gate) => writeFileSync(join(dir, name), JSON.stringify(gate));
  put('formal-a.json', { status: 'passed', level: 'silver', projectDir: 'D:/elsewhere' });
  assert.equal(floor.latestFormalGate(site, 'home', 'D:/mine'), null, 'another workspace’s gate is not ours');
  put('formal-b.json', { status: 'passed', level: 'silver' });
  assert.equal(floor.latestFormalGate(site, 'home', 'D:/mine'), null, 'a legacy gate without projectDir is not trusted');
  put('formal-c.json', { status: 'passed', level: 'gold', projectDir: 'D:/mine' });
  const hit = floor.latestFormalGate(site, 'home', 'D:/mine');
  assert.equal(hit.status, 'passed');
  assert.equal(hit.level, 'gold');
  const gated = makeProject('gated', [iter('run_0401', 'sec-hero', 0.99, 'pass-candidate')]);
  put('formal-d.json', { status: 'failed', level: 'silver', projectDir: gated });
  const delivered = floor.deliverFloor({ projectDir: gated });
  assert.equal(delivered.state, 'failed_with_residuals', 'a failed formal gate keeps the delivery at the floor');
});

test('floor: the mirror copy can be left out for a pure project handoff', () => {
  const projectDir = makeProject('nomirror', [iter('run_0201', 'sec-hero', 0.9)]);
  const r = floor.deliverFloor({ projectDir, mirror: false });
  assert.equal(r.contents.mirror, null);
  assert.equal(existsSync(join(r.outDir, 'mirror')), false);
  assert.equal(existsSync(join(r.outDir, 'project', 'DRAFT.md')), true, 'still a draft: no formal gate yet');
});
