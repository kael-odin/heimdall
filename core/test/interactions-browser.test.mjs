import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-interactions-browser-'));
process.env.HEIMDALL_DATA_DIR = dataDir;
delete process.env.HEIMDALL_TOKEN;
const { scoreInteractions, verifyInteractions } = await import('../src/verify/interactions.mjs');
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

function fixture(action, { attributes = '', setup = '' } = {}) {
  return `<!doctype html><html><body><button ${attributes}>Wait</button><script>
    const button = document.querySelector('button');
    ${setup}
    button.addEventListener('click', () => { ${action} });
  </script></body></html>`;
}

test('real browser interaction comparison is conservative', { timeout: 90_000 }, async t => {
  const change = "button.textContent = 'Done';";
  let source = '', sourceAfterDiscovery = null, sourceLoads = 0, clone = '', cloneClicks = 0, cloneLoads = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/clone-click') {
      cloneClicks++;
      res.writeHead(204).end();
      return;
    }
    if (req.url === '/clone') cloneLoads++;
    if (req.url === '/source') sourceLoads++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/clone' ? clone : req.url === '/source' && sourceAfterDiscovery && sourceLoads > 1 ? sourceAfterDiscovery : source);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const run = () => verifyInteractions(browser, { sourceUrl: origin + '/source', cloneUrl: origin + '/clone', max: 1 });

    await t.test('matching observable changes pass', async () => {
      source = fixture(change); clone = fixture(change);
      const results = await run();
      assert.equal(results[0].pass, true);
      assert.deepEqual(scoreInteractions(results), { total: 1, passed: 1, score: 1 });
    });

    await t.test('a no-op clone cannot pass on pixel similarity', async () => {
      source = fixture(change); clone = fixture('');
      const results = await run();
      assert.equal(results[0].pass, false);
      assert.equal(results[0].stateMatch, false);
      assert.ok(results[0].visualScore >= 0.98, 'a nearly identical screenshot must not override behavior');
    });

    await t.test('an unobservable source action is unverified', async () => {
      source = fixture(''); clone = fixture(change);
      const loads = cloneLoads;
      const results = await run();
      assert.equal(results[0].pass, null);
      assert.equal(results[0].unverified, true);
      assert.equal(scoreInteractions(results), null);
      assert.equal(cloneLoads, loads, 'do not click a clone when the reference action is unobservable');
    });

    await t.test('different initial states are unverified before clicking the clone', async () => {
      source = fixture(change);
      clone = fixture("fetch('/clone-click', { method: 'POST' });", { attributes: 'aria-pressed="true"' });
      const results = await run();
      assert.equal(results[0].pass, null);
      assert.equal(results[0].unverified, true);
      assert.equal(cloneClicks, 0);
    });

    await t.test('a changed source target is unverified before clicking it', async () => {
      source = fixture(change);
      sourceAfterDiscovery = fixture("fetch('/clone-click', { method: 'POST' });").replace('>Wait</button>', '>Other</button>');
      sourceLoads = 0;
      try {
        const results = await run();
        assert.equal(results[0].pass, null);
        assert.equal(results[0].unverified, true);
        assert.equal(cloneClicks, 0);
      } finally { sourceAfterDiscovery = null; }
    });

    await t.test('clone navigation is unverified', async () => {
      source = fixture(change); clone = fixture("location.href = '/destination';");
      const results = await run();
      assert.equal(results[0].pass, null);
      assert.equal(results[0].unverified, true);
    });

    await t.test('same-URL reload is unverified even if it changes visible text', async () => {
      source = fixture("sessionStorage.setItem('done', '1'); location.reload();", {
        setup: "if (sessionStorage.getItem('done')) button.textContent = 'Done';",
      });
      clone = fixture(change);
      const results = await run();
      assert.equal(results[0].pass, null);
      assert.equal(results[0].unverified, true);
    });

    await t.test('truncated page text cannot be used as proof', async () => {
      source = fixture(change).replace('</body>', `<p>${'x'.repeat(200_001)}</p></body>`);
      clone = source;
      const results = await run();
      assert.equal(results[0].pass, null);
      assert.equal(results[0].unverified, true);
    });
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
