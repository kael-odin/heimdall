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
let formal, attempts, browser, server, origin, runStatus = 'running';
const html = '<!doctype html><html><body><main><h1>Local fixture</h1><p>Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu.</p></main></body></html>';
const write = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data); };

before(async () => {
  formal = await import('../src/agent/gate/formal.mjs');
  attempts = await import('../src/agent/gate/attempt.mjs');
  const { launchBrowser } = await import('../src/agent/evidence/capture.mjs');
  browser = await launchBrowser();
  server = createServer((req, res) => {
    if (!req.url.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    res.setHeader('content-type', 'application/json');
    const body = req.method === 'POST' ? { runId: 'run_20261110T000000Z_abcdef' }
      : req.url.endsWith('/report') ? { status: 'completed', gate: 'passed', summary: {} } : { status: runStatus };
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  write(join(root, 'workspace', siteId, 'pages', page, 'clone', 'index.html'), html);
  write(join(root, 'workspace', siteId, 'pages', page, 'dom.html'), html);
  write(join(projectDir, 'heimdall.config.json'), JSON.stringify({ siteId, pages: [{ name: page }], viewports: [375], devServer: { url: origin } }));
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
  const result = await formal.formalGate({ siteId, page, projectDir, engine: origin, timeoutMs: 10000, pollMs: 1, browser });
  assert.equal(result.status, 'passed', JSON.stringify(result.gate.dimensions));
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
