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

test('reviewed discovery explores selected source branches and keeps other branches untested', { timeout: 80_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-reviewed-discovery-'));
  const siteId = '127.0.0.1';
  let reads = 0;
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/read')) {
      reads++;
      response.setHeader('content-type', 'application/json');
      response.end('{"secret":"private-response"}');
      return;
    }
    if (request.url?.startsWith('/api/write')) {
      writes++;
      response.end('written');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body>
      <button type="button" aria-haspopup="menu" aria-expanded="false" id="menu">alice@example.com</button>
      <div role="tab" id="tab">Private tab</div>
      <main id="panel" hidden>private-panel</main>
      <script>
        document.getElementById('menu').onclick = () => {
          document.getElementById('menu').setAttribute('aria-expanded', 'true');
          document.getElementById('panel').hidden = false;
          fetch('/api/read?token=private-query');
        };
        document.getElementById('tab').onclick = () => fetch('/api/write', { method: 'POST' });
      </script>
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
  const pageDir = join(site, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: `${origin}/?token=private-navigation` }));

  const baseline = await runCli(dir, ['discover-operations', siteId]);
  assert.equal(baseline.code, 0, baseline.output);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const reportFile = join(site, 'operation-discovery.json');
  const baselineReport = JSON.parse(readFileSync(reportFile, 'utf8'));
  const candidates = baselineReport.pages[0].candidates;
  assert.deepEqual(candidates.map(candidate => candidate.kind), ['menu', 'tab']);
  const planFile = join(site, 'operation-review.json');
  writeFileSync(planFile, JSON.stringify({ version: 1, origin,
    pages: [{ pageName: 'home', candidates: candidates.map(candidate => ({
      index: candidate.index, kind: candidate.kind, selector: candidate.action.selector,
    })) }],
  }));

  const limited = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed', '--max-actions', '1']);
  assert.equal(limited.code, 1, limited.output);
  const limitedReport = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(limitedReport.summary.reviewedCandidates, 2);
  assert.equal(limitedReport.summary.sourceObservedBranches, 1);
  assert.equal(limitedReport.summary.reviewedUnexplored, 1);
  assert.equal(limitedReport.summary.untestedBranchesLowerBound, 1);
  assert.equal(limitedReport.pages[0].reviewed[0].status, 'source-observed');
  assert.equal(limitedReport.pages[0].reviewed[0].transition.controlStateChanged, true);
  assert.equal(limitedReport.pages[0].reviewed[0].transition.domChanged, true);
  assert.ok(limitedReport.pages[0].reviewed[0].dependencies.categories['dynamic-data'] >= 1);
  assert.equal(limitedReport.pages[0].reviewed[1].reason, 'action-budget');
  assert.ok(reads >= 1);
  assert.equal(writes, 0);

  const both = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed', '--max-actions', '2']);
  assert.equal(both.code, 1, both.output);
  const bothReport = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(bothReport.summary.sourceObservedBranches, 1);
  assert.equal(bothReport.summary.reviewedUnexplored, 1);
  assert.equal(bothReport.summary.reviewedLimited, 1);
  assert.equal(bothReport.pages[0].reviewed[1].status, 'blocked');
  assert.equal(bothReport.pages[0].reviewed[1].reason, 'write-risk-request');
  assert.equal(bothReport.pages[0].reviewed[1].limited, true);
  assert.ok(bothReport.pages[0].reviewed[1].dependencies.outcomes.blocked >= 1);
  assert.equal(writes, 0);
  assert.doesNotMatch(JSON.stringify(bothReport) + both.output,
    /private-navigation|private-query|private-response|private-panel|alice@example.com/);

  const stale = JSON.parse(readFileSync(planFile, 'utf8'));
  stale.pages[0].candidates[0].selector = 'body > :nth-child(99)';
  writeFileSync(planFile, JSON.stringify(stale));
  const staleRun = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed', '--max-actions', '2']);
  assert.equal(staleRun.code, 1, staleRun.output);
  const staleReport = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(staleReport.pages[0].reviewed[0].status, 'unexplored');
  assert.equal(staleReport.pages[0].reviewed[0].reason, 'candidate-changed');
  assert.equal(writes, 0);
});

test('review plan is required and validated before source navigation', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-review-plan-invalid-'));
  const siteId = '127.0.0.1';
  let visited = 0;
  const server = createServer((_request, response) => { visited++; response.end('<html></html>'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); await once(server, 'close');
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = join(dir, 'workspace', siteId);
  const pageDir = join(site, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: origin }));
  const absent = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed']);
  assert.equal(absent.code, 1);
  assert.equal(visited, 0);
  writeFileSync(join(site, 'operation-review.json'), JSON.stringify({ version: 1, origin: 'https://other.test',
    pages: [{ pageName: 'home', candidates: [{ index: 0, kind: 'tab', selector: 'body > :nth-child(1)' }] }],
  }));
  const wrongOrigin = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed']);
  assert.equal(wrongOrigin.code, 1);
  assert.equal(visited, 0);
  const missingFlag = await runCli(dir, ['discover-operations', siteId, '--max-actions', '2']);
  assert.equal(missingFlag.code, 1);
  assert.equal(visited, 0);
});

test('a reviewed aria-expanded button with no effect remains an untested state branch', { timeout: 35_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-review-noop-'));
  const siteId = '127.0.0.1';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><body><button type="button" aria-expanded="false">Open</button></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); await once(server, 'close');
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = join(dir, 'workspace', siteId);
  const pageDir = join(site, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: origin }));

  const discovery = await runCli(dir, ['discover-operations', siteId]);
  assert.equal(discovery.code, 0, discovery.output);
  const reportFile = join(site, 'operation-discovery.json');
  const candidate = JSON.parse(readFileSync(reportFile, 'utf8')).pages[0].candidates[0];
  assert.equal(candidate.kind, 'disclosure');
  writeFileSync(join(site, 'operation-review.json'), JSON.stringify({ version: 1, origin,
    pages: [{ pageName: 'home', candidates: [{
      index: candidate.index, kind: candidate.kind, selector: candidate.action.selector,
    }] }],
  }));

  const reviewed = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed']);
  assert.equal(reviewed.code, 1, reviewed.output);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.summary.reviewedCandidates, 1);
  assert.equal(report.summary.attemptedReviewed, 1);
  assert.equal(report.summary.sourceObservedBranches, 0);
  assert.equal(report.summary.reviewedUnexplored, 1);
  assert.equal(report.summary.untestedBranchesLowerBound, 1);
  assert.equal(report.pages[0].reviewed[0].status, 'no-detected-transition');
  assert.equal(report.pages[0].reviewed[0].reason, 'no-observed-state-change');
  assert.equal(report.pages[0].reviewed[0].transition.observation, 'unchanged');
  assert.equal(report.pages[0].reviewed[0].followup, undefined);
});

test('new tabs exposed by a reviewed menu remain counted as unexplored branches', { timeout: 35_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-review-followup-'));
  const siteId = '127.0.0.1';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body>
      <button type="button" aria-haspopup="menu" aria-expanded="false" id="menu">Menu</button>
      <script>
        document.getElementById('menu').onclick = () => {
          document.getElementById('menu').setAttribute('aria-expanded', 'true');
          document.body.insertAdjacentHTML('beforeend', '<div role="tab">A</div><div role="tab">B</div>');
        };
      </script>
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); await once(server, 'close');
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = join(dir, 'workspace', siteId);
  const pageDir = join(site, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: origin }));

  const discovery = await runCli(dir, ['discover-operations', siteId]);
  assert.equal(discovery.code, 0, discovery.output);
  const reportFile = join(site, 'operation-discovery.json');
  const baseline = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.deepEqual(baseline.pages[0].candidates.map(item => item.kind), ['menu']);
  const menu = baseline.pages[0].candidates[0];
  writeFileSync(join(site, 'operation-review.json'), JSON.stringify({ version: 1, origin,
    pages: [{ pageName: 'home', candidates: [{
      index: menu.index, kind: menu.kind, selector: menu.action.selector,
    }] }],
  }));

  const reviewed = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed']);
  assert.equal(reviewed.code, 0, reviewed.output);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.summary.proposedCandidates, 1);
  assert.equal(report.summary.sourceObservedBranches, 1);
  assert.equal(report.summary.followupCandidates, 3);
  assert.equal(report.summary.followupUntestedBranchesLowerBound, 2);
  assert.equal(report.summary.untestedBranchesLowerBound, 2);
  const branch = report.pages[0].reviewed[0];
  assert.equal(branch.followup.newUntestedBranchesLowerBound, 2);
  assert.equal(branch.followup.newCandidatesUnknown, false);
  assert.deepEqual(branch.followup.candidates.map(item => item.kind), ['menu', 'tab', 'tab']);
});

test('replacing the reviewed control does not invent another unexplored branch', { timeout: 35_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-review-rerender-'));
  const siteId = '127.0.0.1';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body>
      <button type="button" aria-haspopup="menu" aria-expanded="false">Menu</button>
      <script>
        document.querySelector('button').onclick = () => {
          const replacement = document.createElement('button');
          replacement.type = 'button';
          replacement.setAttribute('aria-haspopup', 'menu');
          replacement.setAttribute('aria-expanded', 'true');
          replacement.textContent = 'Menu';
          document.querySelector('button').replaceWith(replacement);
        };
      </script>
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); await once(server, 'close');
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = join(dir, 'workspace', siteId);
  const pageDir = join(site, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: origin }));
  const discovery = await runCli(dir, ['discover-operations', siteId]);
  assert.equal(discovery.code, 0, discovery.output);
  const reportFile = join(site, 'operation-discovery.json');
  const candidate = JSON.parse(readFileSync(reportFile, 'utf8')).pages[0].candidates[0];
  writeFileSync(join(site, 'operation-review.json'), JSON.stringify({ version: 1, origin,
    pages: [{ pageName: 'home', candidates: [{
      index: candidate.index, kind: candidate.kind, selector: candidate.action.selector,
    }] }],
  }));
  const reviewed = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed']);
  assert.equal(reviewed.code, 0, reviewed.output);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.summary.sourceObservedBranches, 1);
  assert.equal(report.summary.followupCandidates, 1);
  assert.equal(report.summary.followupUntestedBranchesLowerBound, 0);
  assert.equal(report.summary.untestedBranchesLowerBound, 0);
  assert.equal(report.pages[0].reviewed[0].followup.newUntestedBranchesLowerBound, 0);
});

test('unrelated periodic DOM updates do not prove a reviewed button changed state', { timeout: 35_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-review-ambient-update-'));
  const siteId = '127.0.0.1';
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body>
      <button type="button" aria-expanded="false">Open</button><span id="clock">0</span>
      <script>setInterval(() => { document.getElementById('clock').textContent = String(Date.now()); }, 50);</script>
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); await once(server, 'close');
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = join(dir, 'workspace', siteId);
  const pageDir = join(site, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: origin }));
  const discovery = await runCli(dir, ['discover-operations', siteId]);
  assert.equal(discovery.code, 0, discovery.output);
  const reportFile = join(site, 'operation-discovery.json');
  const candidate = JSON.parse(readFileSync(reportFile, 'utf8')).pages[0].candidates[0];
  writeFileSync(join(site, 'operation-review.json'), JSON.stringify({ version: 1, origin,
    pages: [{ pageName: 'home', candidates: [{
      index: candidate.index, kind: candidate.kind, selector: candidate.action.selector,
    }] }],
  }));
  const reviewed = await runCli(dir, ['discover-operations', siteId, '--execute-reviewed']);
  assert.equal(reviewed.code, 1, reviewed.output);
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(report.summary.sourceObservedBranches, 0);
  assert.equal(report.summary.untestedBranchesLowerBound, 1);
  assert.equal(report.pages[0].reviewed[0].status, 'page-change-unattributed');
  assert.equal(report.pages[0].reviewed[0].transition.domChanged, true);
  assert.equal(report.pages[0].reviewed[0].transition.observation, 'page-only-change');
});
