import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'heimdall-formal-'));
process.env.HEIMDALL_DATA_DIR = root;
const siteId = 'formal.test';
const page = 'home';
const projectDir = join(root, 'project');
let formal, attempts, browser, server, origin, runStatus = 'running', acceptanceCalls = 0, acceptancePlans = [];
const html = '<!doctype html><html><body><main><h1>Local fixture</h1><p>Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.</p></main></body></html>';
const write = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data); };

before(async () => {
  formal = await import('../src/agent/gate/formal.mjs');
  attempts = await import('../src/agent/gate/attempt.mjs');
  const { launchBrowser } = await import('../src/agent/evidence/capture.mjs');
  browser = await launchBrowser();
  server = createServer((req, res) => {
    const respond = () => {
      if (!req.url.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end(html); return; }
      res.setHeader('content-type', 'application/json');
      const body = req.method === 'POST' ? { runId: `run_20261110T000000Z_${String(++acceptanceCalls).padStart(6, '0')}` }
        : req.url.endsWith('/report') ? { status: 'completed', gate: 'passed', summary: {} } : { status: runStatus };
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { acceptancePlans.push(JSON.parse(body)); respond(); });
      return;
    }
    respond();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  write(join(root, 'workspace', siteId, 'pages', page, 'clone', 'index.html'), html);
  write(join(root, 'workspace', siteId, 'pages', page, 'clone', 'index-375.html'), html + '<!-- mobile -->');
  write(join(root, 'workspace', siteId, 'pages', page, 'clone', 'index-768.html'), html + '<!-- tablet -->');
  write(join(root, 'workspace', siteId, 'pages', page, 'clone', 'index-1440.html'), html + '<!-- desktop -->');
  write(join(root, 'workspace', siteId, 'pages', page, 'dom.html'), html);
  write(join(projectDir, 'heimdall.config.json'), JSON.stringify({ siteId, pages: [{ name: page, route: '/overview' }], viewports: [375, 768, 1440], devServer: { url: origin } }));
  write(join(projectDir, 'index.html'), html);
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

test('formal: only a completed acceptance task and report can pass', () => {
  const report = { status: 'completed', gate: 'passed' };
  assert.equal(formal.acceptanceDimension(report, 'completed').status, 'pass');
  assert.equal(formal.acceptanceDimension(report, 'failed').status, 'not_measured');
  assert.equal(formal.acceptanceDimension({ ...report, status: 'running' }, 'completed').status, 'not_measured');
  assert.equal(formal.acceptanceDimension({ ...report, gate: 'failed' }, 'completed').status, 'fail');
});

test('formal: a missing viewport is incomplete, never a pass', () => {
  const result = formal.acceptanceDimensions([
    { width: 375, status: 'completed', report: { status: 'completed', gate: 'passed', summary: {} } },
  ], [{ width: 375 }, { width: 768 }]);
  assert.equal(result.status, 'not_measured');
  assert.equal(result.value.gate, 'blocked');
});

test('formal: invalid or repeated configured viewports are rejected', () => {
  assert.throws(() => formal.configuredViewports({ viewports: [375, 999] }), /只能取/);
  assert.throws(() => formal.configuredViewports({ viewports: [375, 375] }), /不能重复/);
});

test('formal: a real local timeout persists incomplete and cannot reuse an old pass', { timeout: 120000 }, async () => {
  const prior = attempts.startFormalAttempt({ siteId, page, projectDir, level: 'silver' });
  const { projectFingerprint } = await import('../src/agent/deliver/project.mjs');
  attempts.writeFormalAttempt(prior.file, { ...prior.gate, status: 'passed', projectSnapshot: { schema: 'heimdall.project-snapshot/1', sha256: projectFingerprint(projectDir) } });
  assert.equal(attempts.latestFormalGate(siteId, page, projectDir).status, 'passed');
  const result = await formal.formalGate({ siteId, page, projectDir, engine: origin, timeoutMs: 1, pollMs: 1, browser });
  assert.equal(result.status, 'incomplete');
  assert.equal(JSON.parse(readFileSync(result.reportPath, 'utf8')).reason, 'acceptance_timeout');
  assert.equal(attempts.latestFormalGate(siteId, page, projectDir).reason, 'acceptance_timeout');
});

test('formal: an exception leaves an incomplete attempt', async () => {
  await assert.rejects(formal.formalGate({ siteId, page, projectDir, browser, onProgress() { throw new Error('fixture failure'); } }), /fixture failure/);
  assert.equal(attempts.latestFormalGate(siteId, page, projectDir).reason, 'formal_gate_error');
});

test('formal: a completed local browser run binds the project, and changed files invalidate it', { timeout: 120000 }, async () => {
  runStatus = 'completed';
  const callsBefore = acceptanceCalls;
  const result = await formal.formalGate({ siteId, page, projectDir, engine: origin, timeoutMs: 10000, pollMs: 1, browser });
  assert.equal(result.status, 'passed', JSON.stringify(result.gate.dimensions));
  assert.equal(acceptanceCalls - callsBefore, 3, 'formal gate submits one acceptance run per configured viewport');
  assert.deepEqual(result.acceptance.runIds.length, 3);
  assert.equal(result.acceptance.route, '/overview');
  assert.deepEqual(result.acceptance.viewports.map(item => item.width), [375, 768, 1440]);
  const plans = acceptancePlans.slice(-3);
  assert.deepEqual(plans.map(plan => plan.routes), [['/overview'], ['/overview'], ['/overview']]);
  assert.deepEqual(plans.map(plan => plan.viewports.map(item => item.width)), [[375], [768], [1440]]);
  assert.equal(attempts.latestFormalGate(siteId, page, projectDir).status, 'passed');
  write(join(projectDir, 'index.html'), html + '\n<!-- changed -->');
  assert.equal(attempts.latestFormalGate(siteId, page, projectDir).status, 'incomplete');
});

test('formal: project changes between the start and end of a local run are incomplete', { timeout: 120000 }, async () => {
  const result = await formal.formalGate({ siteId, page, projectDir, engine: origin, timeoutMs: 10000, pollMs: 1, browser,
    onProgress(event) { if (event.stage === 'evaluate') write(join(projectDir, 'index.html'), html + '\n<!-- changed while running -->'); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.gate.reason, 'project_changed_during_gate');
  assert.equal(attempts.latestFormalGate(siteId, page, projectDir).status, 'incomplete');
});
