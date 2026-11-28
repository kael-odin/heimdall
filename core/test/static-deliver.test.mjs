import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const DELIVER = fileURLToPath(new URL('../src/deliver.mjs', import.meta.url));
const HOST = 'fixture.test';
const EVIDENCE_DIR = process.env.HEIMDALL_AUDIT_EVIDENCE_DIR;

function put(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [DELIVER, HOST, ...args], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
  });
}

function output(root) {
  const names = readdirSync(join(root, 'deliverable'));
  return join(root, 'deliverable', names.find(name => name.startsWith(`${HOST}-20`)));
}

test('static deliver sanitizes only its candidate clone and retains the previous bundle', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-static-deliver-'));
  const site = join(root, 'workspace', HOST);
  const clone = join(site, 'pages', 'home', 'clone');
  let browser;
  const legacyChooser = '<!doctype html><script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html")</script>';
  const oldPage = '<!doctype html><html><body><h1>Captured</h1><img src="missing.png" onerror="window.__unsafe=true"><script>window.__unsafe=true</script></body></html>';
  try {
    put(clone, 'index.html', legacyChooser);
    put(clone, 'index-375.html', oldPage);
    put(site, 'pages/about/clone/index.html', oldPage);
    put(site, 'pages/home/manifest.json', JSON.stringify({ target: `https://${HOST}/` }));
    put(site, 'pages/about/manifest.json', JSON.stringify({ target: `https://${HOST}/about` }));
    put(site, 'pages/home/score.json', JSON.stringify({ total: 92, grade: 'B', pixel: 0.92, dom: { dom: 0.9 }, data: { data: 0.9 } }));
    const deliverable = join(root, 'deliverable');
    mkdirSync(deliverable);
    const prior = join(deliverable, `${HOST}-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`);
    put(prior, 'keep.txt', 'last good bundle');

    const first = run(root);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const out = output(root);
    const chooser = readFileSync(join(out, 'site/pages/home/clone/index.html'), 'utf8');
    const cleaned = readFileSync(join(out, 'site/pages/home/clone/index-375.html'), 'utf8');
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    assert.match(readme, /自有或获授权站点/);
    assert.match(readme, /历史辅助口径/);
    assert.match(readme, /v2 多视口验证/);
    const entry = readme.match(/启动后打开 \`\/([^\`]+)\`/);
    assert.ok(entry, 'README links to a concrete bundle entry');
    assert.ok(existsSync(join(out, 'site', entry[1])), 'README entry exists in the bundle');
    assert.match(readme, /没有站点汇总页/);
    assert.match(readme, /\| \`home\` \| 92 \| B \| - \|/, 'missing motion breakdown is not reported as zero');
    assert.doesNotMatch(readme, /抄视觉|抄结构|读竞品|可以直接照搬结构|全部生效 CSS|最终计算态/);
    assert.doesNotMatch(readme, /同一条命令跑两次结果一致|旧的可以删/);
    assert.match(chooser, /location\.replace\(innerWidth<=600\?/);
    assert.doesNotMatch(chooser, /index-768\.html|index-1440\.html/);
    assert.match(cleaned, /<h1>Captured<\/h1>/);
    assert.doesNotMatch(cleaned, /<script\b|\sonerror\s*=/i);
    assert.doesNotMatch(readFileSync(join(out, 'site/pages/about/clone/index.html'), 'utf8'),
      /<script\b|\sonerror\s*=/i, 'single-width historical HTML is sanitized');
    assert.equal(readFileSync(join(clone, 'index-375.html'), 'utf8'), oldPage, 'workspace source remains unchanged');
    browser = await chromium.launch();
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(pathToFileURL(join(out, 'site/pages/home/clone/index.html')).href);
    await mobile.waitForURL('**/index-375.html');
    assert.equal(await mobile.locator('h1').textContent(), 'Captured');
    assert.equal(await mobile.evaluate(() => window.__unsafe === true), false);
    const backup = readdirSync(deliverable).find(name => name.startsWith(`.backup-${HOST}-`));
    assert.equal(readFileSync(join(deliverable, backup, 'keep.txt'), 'utf8'), 'last good bundle');

    rmSync(join(clone, 'index-375.html'));
    const second = run(root);
    assert.notEqual(second.status, 0, 'missing chooser variants must fail candidate validation');
    assert.equal(readFileSync(join(out, 'site/pages/home/clone/index.html'), 'utf8'), chooser,
      'failed rebuild must leave the promoted bundle unchanged');
    assert.ok(readdirSync(deliverable).some(name => name.startsWith(`.candidate-${HOST}-`)),
      'failed candidate remains available for inspection');
    assert.ok(existsSync(join(deliverable, backup, 'keep.txt')));
  } finally {
    await browser?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('static delivery neutralizes native form submissions from disk and plain HTTP', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-static-form-'));
  const site = join(root, 'workspace', HOST);
  const requests = [];
  let exported;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mirror') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(exported));
      return;
    }
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>fixture response</title>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${server.address().port}`;
    const original = `<!doctype html><html><body>
      <form id="main-form" method="post" action="${target}/inner" target="_blank">
        <input id="inner-input" name="value" value="fixture">
        <button id="inner-submit" type="submit">Submit</button>
        <button id="inner-override" type="submit" formaction="${target}/inner-override"
          formmethod="get" formtarget="_blank">Override</button>
      </form>
      <input id="external-input" form="main-form" name="external" value="fixture">
      <button id="external-submit" form="main-form" type="submit"
        formaction="${target}/override" formmethod="post">External submit</button>
      <input id="external-image" form="main-form" type="image" alt="Image submit"
        formaction="${target}/image" style="width:80px;height:24px">
      <form id="enter-form" action="${target}/enter" method="post">
        <input id="enter-input" name="value" value="fixture">
      </form>
      <input id="unrelated-input" value="unrelated">
      <a id="ordinary-link" href="/other">Other page</a>
    </body></html>`;
    const source = put(site, 'pages/home/clone/index.html', original);
    put(site, 'pages/home/manifest.json', JSON.stringify({ target: `https://${HOST}/` }));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(readFileSync(source, 'utf8'), original, 'the historical workspace copy remains unchanged');

    exported = join(output(root), 'site/pages/home/clone/index.html');
    browser = await chromium.launch();
    const page = await browser.newPage();
    const screenshots = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.setContent(original);
      const before = await page.screenshot();
      await page.goto(pathToFileURL(exported).href);
      const after = await page.screenshot();
      assert.equal(after.equals(before), true, `fixture appearance differs at width ${viewport.width}`);
      screenshots.push({ viewport, before, after });
    }
    assert.deepEqual(await page.locator('#main-form').evaluate(form => ({
      action: form.getAttribute('action'), method: form.method, inert: form.inert,
    })), { action: 'about:blank', method: 'dialog', inert: true });
    assert.equal(await page.locator('#external-submit').getAttribute('formaction'), null);
    assert.equal(await page.locator('#external-submit').getAttribute('formmethod'), null);
    assert.equal(await page.locator('#external-submit').evaluate(button => button.inert), true);
    assert.equal(await page.locator('#unrelated-input').evaluate(input => input.inert), false);
    assert.equal(await page.locator('[formaction], [formmethod], [formtarget]').count(), 0);
    const click = async selector => {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box, `${selector} remains visible`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const actions = [
      ['inside submit', () => click('#inner-submit')],
      ['inside form override', () => click('#inner-override')],
      ['outside form override', () => click('#external-submit')],
      ['outside image submit', () => click('#external-image')],
      ['inside enter', async () => { await click('#enter-input'); await page.keyboard.press('Enter'); }],
      ['outside enter', async () => { await click('#external-input'); await page.keyboard.press('Enter'); }],
      ['requestSubmit', () => page.evaluate(() => document.querySelector('#main-form').requestSubmit())],
      ['requestSubmit with outside override', () => page.evaluate(() => {
        document.querySelector('#main-form').requestSubmit(document.querySelector('#external-submit'));
      })],
      ['submit', () => page.evaluate(() => document.querySelector('#main-form').submit())],
    ];
    for (const entry of [pathToFileURL(exported).href, `${target}/mirror`]) {
      for (const [label, action] of actions) {
        await page.goto(entry);
        await action();
        await page.waitForTimeout(300);
        assert.deepEqual(requests, [], `${label} sent a request to the fixture server`);
        assert.equal(page.url(), entry, `${label} navigated away from the mirror`);
      }
    }
    assert.equal(await page.locator('#ordinary-link').getAttribute('href'), '/other');
    if (EVIDENCE_DIR) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      for (const { viewport, before, after } of screenshots) {
        writeFileSync(join(EVIDENCE_DIR, `before-${viewport.width}.png`), before);
        writeFileSync(join(EVIDENCE_DIR, `after-${viewport.width}.png`), after);
      }
      writeFileSync(join(EVIDENCE_DIR, 'result.json'), JSON.stringify({
        kind: 'local-synthetic-fixture', browser: browser.version(),
        entryModes: ['file', 'plain-http'], actions: actions.map(([label]) => label),
        attempts: actions.length * 2, unexpectedRequestsToFixture: requests.length,
        screenshotWidths: screenshots.map(item => item.viewport.width), screenshotsIdentical: true,
      }, null, 2));
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
