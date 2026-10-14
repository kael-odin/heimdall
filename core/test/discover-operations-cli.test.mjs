import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const CORE = fileURLToPath(new URL('..', import.meta.url));

async function runCli(dataDir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('CLI discovers private candidates from bounded captured source pages with saved session', { timeout: 45_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-discovery-'));
  const siteId = '127.0.0.1';
  let writes = 0;
  let reads = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/write')) { writes++; response.end('written'); return; }
    if (request.url?.startsWith('/api/read')) { reads++; response.end('read'); return; }
    if (!request.headers.cookie?.includes('sid=cookie-secret')) {
      response.writeHead(403); response.end('login required'); return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body>
      <button type="button" aria-haspopup="menu">alice@example.com</button>
      <script>
        if (sessionStorage.getItem('signed-in') === 'storage-secret') {
          document.body.insertAdjacentHTML('beforeend', '<div role="tab">Private tab</div>');
        }
        fetch('/api/write?token=write-secret', { method: 'POST' }).catch(() => {});
        new WebSocket('ws://' + location.host + '/stream');
      </script>
      <img src="https://external.test/tracker?token=external-secret">
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = join(dir, 'workspace', siteId);
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  for (const name of ['a', 'b', 'c']) {
    const pageDir = join(site, 'pages', name);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: `${origin}/${name}?token=navigation-secret` }));
  }
  writeFileSync(join(site, 'pages', 'c', 'manifest.json'), JSON.stringify({ target: 'https://external.test/steal?token=cross-origin-secret' }));
  writeFileSync(join(site, 'session.json'), JSON.stringify({
    cookies: [{ name: 'sid', value: 'cookie-secret', domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
    sessionStorage: [{ origin, entries: [{ name: 'signed-in', value: 'storage-secret' }] }],
  }));

  const { code, output } = await runCli(dir, ['discover-operations', siteId, '--max-pages', '2']);
  assert.equal(code, 0, output);
  const file = join(site, 'operation-discovery.json');
  assert.equal(existsSync(file), true);
  const raw = readFileSync(file, 'utf8');
  const report = JSON.parse(raw);
  assert.equal(report.sessionUsed, true);
  assert.equal(report.summary.capturedPages, 3);
  assert.equal(report.summary.attemptedPages, 2);
  assert.equal(report.summary.omittedPages, 1);
  assert.equal(report.summary.observedPages, 2);
  assert.equal(report.summary.proposedCandidates, 4);
  assert.equal(report.summary.untestedBranchesLowerBound, 4);
  assert.equal(report.summary.unknownBranchesBeyondScope, true);
  assert.ok(report.summary.blockedRequests >= 6);
  assert.equal(report.policy.futureStatesUntested, true);
  assert.ok(report.pages.every(page => page.candidates.every(candidate => candidate.status === 'untested')));
  assert.ok(report.pages.every(page => page.requests.blockedWrite >= 1));
  assert.ok(report.pages.every(page => page.requests.blockedExternal >= 1));
  assert.ok(report.pages.every(page => page.requests.blockedWebSocket >= 1));
  assert.equal(writes, 0);
  assert.equal(reads, 0);
  assert.doesNotMatch(raw + output, /cookie-secret|storage-secret|navigation-secret|write-secret|external-secret|alice@example.com/);

  const extended = await runCli(dir, ['discover-operations', siteId, '--max-pages', '3']);
  assert.equal(extended.code, 1, extended.output);
  const second = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(second.pages[2].status, 'unavailable');
  assert.equal(second.pages[2].reason, 'invalid-or-cross-origin-manifest');
  assert.equal(second.summary.failedPages, 1);
  assert.doesNotMatch(JSON.stringify(second) + extended.output, /cross-origin-secret|external\.test/);
});

test('CLI rejects invalid budgets before visiting the source', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-operation-discovery-args-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, output } = await runCli(dir, ['discover-operations', 'fixture.test', '--max-pages', '0']);
  assert.equal(code, 1);
  assert.match(output, /discover-operations <siteId>/);
});
