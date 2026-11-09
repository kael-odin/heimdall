import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const PAGE = `<!doctype html><html><head><title>Local capture fixture</title></head><body>
  <form onsubmit="event.preventDefault(); fetch('/button-write', {method:'POST'})">
    <button>Accept</button>
  </form>
  <script>fetch('/page-write', {method:'POST'});</script>
</body></html>`;

function runNode(args, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_LLM: '0' },
    });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, log }));
  });
}

const runCapture = (url, out, root) => runNode(['src/crawler/capture.mjs', url, out], root);
const runSeo = (url, _out, root) => runNode(['--input-type=module', '-e', `
  import { chromium } from 'playwright';
  import { collectPage } from './src/seo/collect.mjs';
  const browser = await chromium.launch();
  try {
    const result = await collectPage(browser, process.argv[1], { settleMs: 50 });
    if (result.status !== 200) throw new Error('SEO fixture did not load');
  } finally { await browser.close(); }
`, url], root);

async function withFixture(t, consentButton, run = runCapture) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-capture-effects-'));
  const seen = { page: 0, button: 0 };
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/page-write') seen.page++;
    if (req.method === 'POST' && req.url === '/button-write') seen.button++;
    if (req.method === 'POST') return res.writeHead(204).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const site = join(root, 'workspace', '127.0.0.1');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'site.json'), JSON.stringify({ capture: {
    scrollSweep: false, settleMs: 0, ...(consentButton ? { consentButton } : {}),
  } }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const result = await run(url, join(root, 'capture'), root);
  assert.equal(result.code, 0, result.log);
  return seen;
}

test('capture leaves buttons untouched by default even when their names match consent', { timeout: 90_000 }, async t => {
  const seen = await withFixture(t);
  assert.ok(seen.page > 0, 'page scripts can still make POST requests; capture is not a read-only sandbox');
  assert.equal(seen.button, 0, 'a generic Accept button must not be clicked automatically');
});

test('an explicitly configured consent button can still submit and must be treated as risky', { timeout: 90_000 }, async t => {
  const seen = await withFixture(t, '^Accept$');
  assert.ok(seen.page > 0);
  assert.equal(seen.button, 1, 'an explicit consentButton opts into a real page click');
});

test('SEO collection runs page scripts without clicking the consent-like button', { timeout: 90_000 }, async t => {
  const seen = await withFixture(t, null, runSeo);
  assert.ok(seen.page > 0, 'SEO collection is not a read-only browser sandbox');
  assert.equal(seen.button, 0);
});
