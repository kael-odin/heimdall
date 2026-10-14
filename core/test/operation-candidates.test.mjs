import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { discoverOperationCandidates } from '../src/crawler/operation-candidates.mjs';

async function fixture(t) {
  let writes = 0;
  let reads = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      if (request.method === 'POST') writes++;
      else reads++;
      response.end('ok');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body>
      <button type="button" aria-haspopup="menu" aria-expanded="false" id="secret-menu">alice@example.com</button>
      <div role="tab" id="secret-tab">Private tab</div>
      <button type="button" aria-expanded="false">Disclosure</button>
      <nav aria-label="Pagination"><a href="/page/2?token=private-token" rel="next">Next</a>
        <a href="https://other.test/page/3">External</a><a>No href</a></nav>
      <form><button type="submit" aria-expanded="false">Save</button></form>
      <button type="button" role="tab" disabled>Disabled tab</button>
      <script>
        document.querySelector('#secret-menu').onclick = () => fetch('/api/delete', { method: 'POST' });
        document.querySelector('#secret-tab').onclick = () => fetch('/api/list');
      </script>
    </body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(async () => {
    await context.close();
    await browser.close();
    server.close();
    await once(server, 'close');
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await context.newPage();
  await page.goto(`${origin}/?session=private-session`);
  return { page, origin, writes: () => writes, reads: () => reads };
}

test('proposes bounded light-DOM operations without executing them or exposing page values', { timeout: 30_000 }, async t => {
  const { page, origin, writes, reads } = await fixture(t);
  const report = await discoverOperationCandidates(page, { maxCandidates: 2 });
  assert.equal(report.source, `${origin}/`);
  assert.deepEqual(report.candidates.map(candidate => candidate.kind), ['menu', 'tab']);
  assert.deepEqual(report.candidates.map(candidate => candidate.status), ['untested', 'untested']);
  assert.equal(report.summary.recognized, 4);
  assert.equal(report.summary.proposed, 2);
  assert.equal(report.summary.omittedByBudget, 2);
  assert.equal(report.summary.untestedBranchesLowerBound, 4);
  assert.equal(report.summary.unknownBranchesBeyondScope, false);
  assert.equal(report.policy.execution, 'none');
  for (const candidate of report.candidates) {
    assert.equal(await page.locator(candidate.action.selector).count(), 1);
    assert.match(candidate.action.selector, /^body > (?::nth-child\(\d+\)(?: > )?)+$/);
  }
  assert.equal(writes(), 0);
  assert.equal(reads(), 0);
  assert.doesNotMatch(JSON.stringify(report), /private-token|private-session|alice@example.com|secret-menu|secret-tab|Save|\/page\/2/);
});

test('reports scan and DOM scope limits as untested, without claiming full discovery', { timeout: 30_000 }, async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<button role="tab">Shadow tab</button>';
    const frame = document.createElement('iframe');
    frame.srcdoc = '<button role="tab">Frame tab</button>';
    document.body.append(frame);
  });
  const scoped = await discoverOperationCandidates(page);
  assert.equal(scoped.summary.recognized, 4);
  assert.equal(scoped.summary.framesObserved, 1);
  assert.equal(scoped.summary.openShadowRootsObserved, 1);
  assert.equal(scoped.summary.unknownBranchesBeyondScope, true);

  const limited = await discoverOperationCandidates(page, { maxInspected: 2, maxCandidates: 0 });
  assert.equal(limited.summary.inspected, 2);
  assert.equal(limited.summary.scanTruncated, true);
  assert.equal(limited.summary.proposed, 0);
  assert.equal(limited.summary.untestedBranchesLowerBound, 1);
  assert.equal(limited.summary.unknownBranchesBeyondScope, true);
});
