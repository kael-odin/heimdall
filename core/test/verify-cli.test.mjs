import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

function runVerify(dataDir, args, env = {}, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/verify/verify.mjs', import.meta.url)), ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, ...env },
    });
    let output = '';
    child.stdout.on('data', x => { output += x; });
    child.stderr.on('data', x => { output += x; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('verify hung: ' + output)); }, timeout);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('verify --all considers all 11 pages and fails the gate for missing clones', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-'));
  const base = join(dataDir, 'workspace', 'x.test');
  try {
    for (let i = 1; i <= 11; i++) {
      const page = join(base, 'pages', 'p' + i);
      mkdirSync(page, { recursive: true });
      writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://x.test/p' + i }));
    }
    const { code, output } = await runVerify(dataDir, ['x.test', '--all', '--no-interactions', '--viewports', '10x10']);
    assert.equal(code, 1, output);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.targetTotal, 11);
    assert.equal(summary.selected, 11);
    assert.equal(summary.pages.length, 11);
    assert.equal(summary.measured, 0);
    assert.equal(summary.untested, 11);
    assert.equal(summary.passed, false);
    assert.equal(summary.scoreVersion, 2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('verify rejects empty viewports, invalid threshold, and unsafe site ids before writing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-args-'));
  try {
    for (const args of [
      ['x.test', '--all', '--viewports', ''],
      ['x.test', '--all', '--threshold', 'nonsense'],
      ['..', '--all'],
    ]) {
      const result = await runVerify(dataDir, args);
      assert.equal(result.code, 2, result.output);
    }
    const invalidSettle = await runVerify(dataDir, ['x.test', '--all'],
      { HEIMDALL_VERIFY_SETTLE_TIMEOUT_MS: '2000' });
    assert.equal(invalidSettle.code, 2, invalidSettle.output);
    assert.equal(existsSync(join(dataDir, 'workspace')), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('verify --all counts an existing page directory with no manifest as unmeasured', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-no-manifest-'));
  const base = join(dataDir, 'workspace', 'x.test');
  try {
    mkdirSync(join(base, 'pages', 'orphan', 'clone'), { recursive: true });
    writeFileSync(join(base, 'pages', 'orphan', 'clone', 'index.html'), '<html></html>');
    const { code, output } = await runVerify(dataDir, ['x.test', '--all', '--no-interactions']);
    assert.equal(code, 1, output);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.targetTotal, 1);
    assert.equal(summary.untested, 1);
    assert.equal(summary.pages[0].page, 'orphan');
    assert.match(summary.pages[0].error, /invalid manifest target/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('verify --page-dir writes isolated candidate results', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-stage-'));
  const stage = join(dataDir, 'workspace', 'x.test', 'audit', 'upgrade-candidates', 'p1-candidate');
  try {
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ target: 'https://x.test/p1' }));
    const { code, output } = await runVerify(dataDir, ['x.test', 'p1', '--page-dir', stage, '--no-interactions', '--viewports', '10x10']);
    assert.equal(code, 1, output);
    const result = JSON.parse(readFileSync(join(stage, 'verify', 'verify.json'), 'utf8'));
    assert.equal(result.page, 'p1');
    assert.equal(result.error, 'clone/index.html missing');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('invalid manifest replaces a previously passing page result', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-invalid-manifest-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const verifyFile = join(base, 'verify', 'p1', 'verify.json');
  try {
    mkdirSync(join(page, 'clone'), { recursive: true });
    mkdirSync(join(base, 'verify', 'p1'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<html></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'not-a-url' }));
    writeFileSync(verifyFile, JSON.stringify({ page: 'p1', scoreVersion: 2, measured: true, overall: 1, grade: 'A', minViewport: { score: 1 } }));

    const { code, output } = await runVerify(dataDir, ['x.test', 'p1', '--no-interactions']);
    assert.equal(code, 1, output);
    const result = JSON.parse(readFileSync(verifyFile, 'utf8'));
    assert.equal(result.scoreVersion, 2);
    assert.equal(result.measured, false);
    assert.equal(result.overall, null);
    assert.equal(result.minViewport, null);
    assert.match(result.error, /^invalid manifest target:/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('verify blocks visible broken images but records hidden tracking pixels separately', { timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-broken-images-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const server = createServer((req, res) => {
    if (req.url === '/ok.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
      return;
    }
    if (req.url === '/missing.svg') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/scroll'
      ? '<!doctype html><html><body style="margin:0"><div style="height:1400px"></div></body></html>'
      : ['/hidden', '/self-hidden', '/visibility', '/visibility-override', '/transparent',
        '/offscreen-fixed-x', '/offscreen-fixed-y'].includes(req.url)
        ? '<!doctype html><html><body style="margin:0;height:100px"></body></html>'
        : req.url === '/scaled'
          ? '<!doctype html><html><body style="margin:0;height:100px"><img src="/ok.svg" width="1" height="1" style="width:40px;height:40px"></body></html>'
          : `<!doctype html><html><body style="margin:0;height:100px"><img src="${req.url === '/baseline' ? '/missing.svg' : '/ok.svg'}" alt="" width="8" height="8"></body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    for (const name of ['baseline', 'regression', 'scroll', 'hidden', 'self-hidden', 'visibility',
      'visibility-override', 'transparent', 'offscreen-fixed-x', 'offscreen-fixed-y', 'scaled']) {
      const page = join(base, 'pages', name);
      mkdirSync(join(page, 'clone'), { recursive: true });
      writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/${name}` }));
      const cloneHtml = name === 'scroll'
        ? `<!doctype html><html><body style="margin:0"><div style="height:1400px"></div><script>
            addEventListener('scroll', () => {
              if (document.querySelector('img')) return;
              const img = document.createElement('img');
              img.src = 'missing.svg'; img.width = 8; img.height = 8;
              img.style.cssText = 'position:absolute;top:1200px;left:0';
              document.body.append(img);
            });
          </script></body></html>`
        : name === 'hidden'
          ? '<!doctype html><html><body style="margin:0;height:100px"><div style="display:none"><img src="missing.svg" width="1" height="1"></div></body></html>'
          : name === 'self-hidden'
            ? '<!doctype html><html><body style="margin:0;height:100px"><img src="missing.svg" width="1" height="1" style="display:none"></body></html>'
            : name === 'visibility'
              ? '<!doctype html><html><body style="margin:0;height:100px"><div style="visibility:hidden"><img src="missing.svg" width="1" height="1"></div></body></html>'
                : name === 'visibility-override'
                  ? '<!doctype html><html><body style="margin:0;height:100px"><div style="visibility:hidden"><img src="missing.svg" width="1" height="1" style="visibility:visible"></div></body></html>'
              : name === 'transparent'
                ? '<!doctype html><html><body style="margin:0;height:100px"><div style="opacity:0.0"><img src="missing.svg" width="1" height="1"></div></body></html>'
                : name === 'offscreen-fixed-x'
                  ? '<!doctype html><html><body style="margin:0;height:100px"><img src="missing.svg" style="position:fixed;left:-10000px;top:0;width:20px;height:20px"></body></html>'
                  : name === 'offscreen-fixed-y'
                    ? '<!doctype html><html><body style="margin:0;height:100px"><img src="missing.svg" style="position:fixed;left:0;top:10000px;width:20px;height:20px"></body></html>'
                : name === 'scaled'
                  ? '<!doctype html><html><body style="margin:0;height:100px"><img src="missing.svg" width="1" height="1" style="width:40px;height:40px"></body></html>'
                  : '<!doctype html><html><body style="margin:0;height:100px"><img src="missing.svg" alt="" width="8" height="8"></body></html>';
      writeFileSync(join(page, 'clone', 'index.html'), cloneHtml);
    }

    const { code, output } = await runVerify(dataDir,
      ['x.test', '--all', '--no-interactions', '--viewports', '100x100'], {}, 75_000);
    assert.equal(code, 1, output);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    const result = name => JSON.parse(readFileSync(join(base, 'verify', name, 'verify.json'), 'utf8'));
    const baseline = result('baseline');
    assert.equal(baseline.measured, true, output);
    assert.equal(baseline.grade, 'A');
    assert.equal(baseline.viewports[0].sourceCapture.settle.afterScroll.brokenImages, 1);
    assert.equal(baseline.viewports[0].cloneCapture.settle.afterScroll.brokenImages, 1);
    assert.equal(baseline.viewports[0].cloneCapture.settle.afterScroll.visibleBrokenImages, 1);
    assert.equal(baseline.viewports[0].additionalBrokenImages, 0);
    assert.equal(baseline.viewports[0].additionalVisibleBrokenImages, 0);

    const regression = result('regression');
    assert.equal(regression.viewports[0].sourceCapture.settle.beforeScroll.brokenImages, 0);
    assert.equal(regression.viewports[0].cloneCapture.settle.beforeScroll.brokenImages, 1);
    assert.equal(regression.viewports[0].additionalBrokenImages, 1);
    assert.equal(regression.viewports[0].additionalVisibleBrokenImages, 1);
    assert.ok(regression.viewports[0].score > 0.95);
    assert.equal(regression.viewports[0].grade, null);
    assert.equal(regression.measured, false);
    assert.equal(regression.grade, null);
    assert.equal(regression.minViewport.grade, null);
    assert.match(regression.error, /additional visible broken image/);

    const scroll = result('scroll');
    assert.equal(scroll.viewports[0].cloneCapture.settle.beforeScroll.brokenImages, 0);
    assert.equal(scroll.viewports[0].cloneCapture.settle.afterScroll.brokenImages, 1);
    assert.equal(scroll.viewports[0].additionalBrokenImages, 1);
    assert.equal(scroll.viewports[0].additionalVisibleBrokenImages, 1);
    assert.equal(scroll.measured, false);

    for (const name of ['hidden', 'self-hidden', 'visibility', 'transparent', 'offscreen-fixed-x', 'offscreen-fixed-y']) {
      const page = result(name);
      assert.equal(page.measured, true, `${name}: ${output}`);
      assert.equal(page.viewports[0].cloneCapture.settle.afterScroll.brokenImages, 1);
      assert.equal(page.viewports[0].cloneCapture.settle.afterScroll.visibleBrokenImages, 0);
      assert.equal(page.viewports[0].additionalBrokenImages, 1);
      assert.equal(page.viewports[0].additionalVisibleBrokenImages, 0);
    }

    const scaled = result('scaled');
    assert.equal(scaled.viewports[0].additionalBrokenImages, 1);
    assert.equal(scaled.viewports[0].additionalVisibleBrokenImages, 1);
    assert.equal(scaled.measured, false);
    const visibilityOverride = result('visibility-override');
    assert.equal(visibilityOverride.viewports[0].additionalVisibleBrokenImages, 1);
    assert.equal(visibilityOverride.measured, false);
    assert.equal(summary.passed, false);
    assert.equal(summary.measured, 7);
    assert.equal(summary.untested, 4);
    assert.deepEqual(summary.failedPages.map(page => page.page).sort(), ['regression', 'scaled', 'scroll', 'visibility-override']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify --all excludes a partially measured page from worst viewport', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-partial-verify-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>local fixture</body></html>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body>local fixture</body></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/p1` }));

    const { code, output } = await runVerify(dataDir,
      ['x.test', '--all', '--no-interactions', '--viewports', '10x10,10x26000'],
      { HEIMDALL_PORT: String(port) }, 45_000);
    assert.equal(code, 1, output);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.pages.length, 1);
    assert.equal(summary.pages[0].measured, false);
    assert.equal(typeof summary.pages[0].minViewport?.score, 'number');
    assert.equal(summary.measured, 0);
    assert.equal(summary.untested, 1);
    assert.equal(summary.worst, null);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify waits for the first async batch before triggering scroll pagination', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-scroll-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const server = createServer((req, res) => {
    if (req.url === '/data') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, 900);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url?.startsWith('/static/')) {
      res.end('<!doctype html><html><body><div style="height:5000px"></div></body></html>');
      return;
    }
    res.end(`<!doctype html><html><body><div id="list" style="height:1000px"></div>
      <script>
        fetch('/data').then(() => { document.querySelector('#list').style.height = '3000px'; });
        addEventListener('scroll', () => {
          if (scrollY > 1200) document.querySelector('#list').style.height = '5000px';
        });
      </script></body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><div style="height:5000px"></div></body></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));

    const { code, output } = await runVerify(dataDir,
      ['x.test', 'p1', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 30_000);
    assert.equal(code, 0, output);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, true);
    assert.ok(result.viewports[0].sourceHeight > 4000);
    assert.equal(result.viewports[0].sourceHeight, result.viewports[0].cloneHeight);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify bounds long polling and marks the result unmeasured', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-poll-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const server = createServer((req, res) => {
    if (req.url === '/poll') return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><div style="height:1000px"></div>
      ${req.url?.startsWith('/static/') ? '' : "<script>fetch('/poll').catch(() => {})</script>"}
    </body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><div style="height:1000px"></div></body></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));

    const started = Date.now();
    const { code, output } = await runVerify(dataDir,
      ['x.test', 'p1', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 20_000);
    assert.equal(code, 1, output);
    assert.ok(Date.now() - started < 15_000, output);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, false);
    assert.equal(result.overall, null);
    assert.equal(typeof result.provisionalOverall, 'number');
    assert.equal(result.grade, null);
    assert.equal(result.viewports[0].settleTimedOut, true);
    assert.equal(result.viewports[0].sourceCapture.settle.beforeScroll.stable, false);
    assert.equal(result.viewports[0].sourceCapture.settle.afterScroll.stable, false);
    assert.equal(typeof result.viewports[0].score, 'number');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an offscreen lazy image does not block a settled full-page measurement', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-lazy-offscreen-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  let imageRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/never-image') { imageRequests++; return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body style="margin:0"><div style="height:1500px"></div>
      <img loading="lazy" src="/never-image" style="position:fixed;left:-10000px;top:0;width:20px;height:20px"></body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), `<!doctype html><html><body style="margin:0"><div style="height:1500px"></div>
      <img loading="lazy" src="/never-image" style="position:fixed;left:-10000px;top:0;width:20px;height:20px"></body></html>`);
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));
    const { code, output } = await runVerify(dataDir,
      ['x.test', 'p1', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 20_000);
    assert.equal(code, 0, output);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, true);
    assert.equal(result.viewports[0].score, 1);
    assert.equal(imageRequests, 0);
    for (const capture of [result.viewports[0].sourceCapture, result.viewports[0].cloneCapture]) {
      assert.equal(capture.settle.beforeScroll.incompleteImages, 1);
      assert.equal(capture.settle.beforeScroll.visibleIncompleteImages, 0);
      assert.equal(capture.settle.afterScroll.incompleteImages, 1);
      assert.equal(capture.settle.afterScroll.visibleIncompleteImages, 0);
      assert.equal(capture.settle.scrollConverged, true);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an image request started by scrolling still blocks measurement until it settles', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-scroll-image-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  let imageRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/slow-image') { imageRequests++; return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url?.startsWith('/static/')) {
      res.end('<!doctype html><html><body style="margin:0"><div style="height:2000px"></div></body></html>');
      return;
    }
    res.end(`<!doctype html><html><body style="margin:0"><div style="height:2000px"></div>
      <script>let started = false; addEventListener('scroll', () => {
        if (scrollY > 500 && !started) {
          started = true;
          const image = document.createElement('img');
          image.src = '/slow-image';
          image.style.cssText = 'position:fixed;left:-10000px;top:0;width:20px;height:20px';
          document.body.append(image);
        }
      });</script></body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));
    const { code, output } = await runVerify(dataDir,
      ['x.test', 'p1', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 20_000);
    assert.equal(code, 1, output);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, false);
    assert.ok(imageRequests >= 1);
    assert.equal(result.viewports[0].sourceCapture.settle.beforeScroll.stable, true);
    assert.equal(result.viewports[0].sourceCapture.settle.afterScroll.stable, false);
    assert.ok(result.viewports[0].sourceCapture.settle.afterScroll.pendingRequests >= 1);
    assert.equal(result.viewports[0].sourceCapture.settle.afterScroll.visibleIncompleteImages, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify marks a continually growing scroll page unmeasured', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-growing-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url?.startsWith('/static/')) {
      res.end('<!doctype html><html><body><div style="height:3000px"></div></body></html>');
      return;
    }
    res.end(`<!doctype html><html><body><div id="content" style="height:3000px"></div>
      <script>
        let height = 3000;
        addEventListener('scroll', () => {
          if (scrollY > height - 1200) {
            height += 1000;
            document.querySelector('#content').style.height = height + 'px';
          }
        });
      </script></body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><div style="height:3000px"></div></body></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));
    const { code, output } = await runVerify(dataDir,
      ['x.test', 'p1', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 45_000);
    assert.equal(code, 1, output);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, false);
    assert.equal(result.overall, null);
    assert.equal(result.viewports[0].sourceCapture.settle.scrollConverged, false);
    assert.ok(result.viewports[0].sourceHeight > 3000);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify measures a 26k page with bounded screenshot tiles', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-verify-tiled-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const height = 26_100;
  const html = `<!doctype html><html><body style="margin:0"><div style="height:${height}px;background:linear-gradient(#fff,#444)"></div></body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), html);
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));
    const { code, output } = await runVerify(dataDir,
      ['x.test', 'p1', '--no-interactions', '--keep-screenshots', '--viewports', '40x100'],
      { HEIMDALL_PORT: String(port) }, 60_000);
    assert.equal(code, 0, output);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, true);
    assert.equal(result.viewports[0].captureMode, 'tiled');
    assert.equal(result.viewports[0].sourceHeight, height);
    assert.equal(result.viewports[0].cloneHeight, height);
    assert.equal(result.viewports[0].score, 1);
    assert.equal(result.viewports[0].diffParts.length, 7);
    const captureDir = join(base, 'verify', 'p1');
    const first = PNG.sync.read(readFileSync(join(captureDir, 'src-40x100-part-001.png')));
    const last = PNG.sync.read(readFileSync(join(captureDir, 'src-40x100-part-007.png')));
    assert.ok(first.data[0] > last.data[0] + 100, 'deep tile must contain rendered page pixels');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- --resume ----------

/**
 * 断点续跑的意义：真实站点的 verify --all 按小时计（每页 3 视口 + 交互回放），
 * 中途断掉就得从头再来。这组用例钉住三条契约：
 *   1. 已完整测过、输入和证据没变过的页，不重跑，直接复用；
 *   2. 输入或选项变化、旧缓存无指纹、上次没测成时必须重跑；
 *   3. 复用不是"假绿"：摘要里 reused 与 measured 分开计数，
 *      整站门禁仍然按"全部页都测到"算。
 */
function seedPage(dataDir, name, { overall = 0.9, measured = true, scoreVersion = 2, viewports, target = `https://x.test/${name}` } = {}) {
  const base = join(dataDir, 'workspace', 'x.test');
  const dir = join(base, 'pages', name);
  mkdirSync(join(dir, 'clone'), { recursive: true });
  writeFileSync(join(dir, 'clone', 'index.html'), '<html><body>x</body></html>');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target }));
  mkdirSync(join(base, 'verify', name), { recursive: true });
  const file = join(base, 'verify', name, 'verify.json');
  writeFileSync(file, JSON.stringify({
    page: name, scoreVersion, measured, overall: measured ? overall : null,
    grade: measured ? 'A' : null, minViewport: measured ? { name: '10x10', score: overall } : null,
    viewports: viewports ?? [{ name: '10x10', score: overall }],
  }));
  // verify.json 必须比克隆产物新，否则会被判成"克隆后没重测过"
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(dir, 'manifest.json'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  utimesSync(join(dir, 'clone', 'index.html'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  utimesSync(file, future, future);
  return { base, dir, file };
}

test('verify --resume remeasures when a clone stylesheet changes', { timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-css-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const html = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body></body></html>';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': req.url === '/style.css' ? 'text/css' : 'text/html' });
    res.end(req.url === '/style.css' ? 'body { margin: 0; background: red; }' : html);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${server.address().port}/` }));
    writeFileSync(join(page, 'clone', 'index.html'), html);
    writeFileSync(join(page, 'clone', 'style.css'), 'body { margin: 0; background: red; }');
    const args = ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '100x100'];
    const first = await runVerify(dataDir, args, {}, 30_000);
    assert.equal(first.code, 0, first.output);
    const resultFile = join(base, 'verify', 'p1', 'verify.json');
    const firstBytes = readFileSync(resultFile);
    const firstResult = JSON.parse(firstBytes);
    assert.equal(firstResult.overall, 1);
    assert.ok(firstResult.resumeCache?.inputs);
    const before = statSync(resultFile).mtimeMs;
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(page, 'clone', 'index.html'), future, future);
    const reused = await runVerify(dataDir, args, {}, 30_000);
    assert.equal(reused.code, 0, reused.output);
    const reusedSummary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(reusedSummary.reused, 1, reused.output);
    assert.equal(reusedSummary.pages[0].measuredAt, firstResult.generatedAt);
    assert.equal(statSync(resultFile).mtimeMs, before);

    const oldStyle = statSync(join(page, 'clone', 'style.css'));
    writeFileSync(join(page, 'clone', 'style.css'), 'body { margin: 0; background: blue; }');
    utimesSync(join(page, 'clone', 'style.css'), oldStyle.atime, oldStyle.mtime);
    const second = await runVerify(dataDir, args, {}, 30_000);
    assert.equal(second.code, 0, second.output);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.reused, 0, second.output);
    assert.ok(summary.average < 1, second.output);
    const gated = await runVerify(dataDir, [...args, '--threshold', '100'], {}, 30_000);
    assert.equal(gated.code, 1, gated.output);
    const gatedSummary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(gatedSummary.reused, 1, gated.output);
    assert.equal(gatedSummary.passed, false, gated.output);
    const history = join(base, 'verify', '.resume-history');
    const archivedPage = readdirSync(history).find(name => name.startsWith('page-'));
    assert.deepEqual(readFileSync(join(history, archivedPage, 'verify.json')), firstBytes);
    assert.ok(existsSync(join(history, archivedPage, 'diff-100x100.png')));
    assert.ok(readdirSync(history).some(name => name.startsWith('summary-')));

    const kept = await runVerify(dataDir, [...args, '--keep-screenshots'], {}, 30_000);
    assert.equal(kept.code, 0, kept.output);
    assert.equal(JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8')).reused, 0);
    const screenshot = join(base, 'verify', 'p1', 'src-100x100.png');
    assert.ok(existsSync(screenshot));
    rmSync(screenshot);
    const missing = await runVerify(dataDir, [...args, '--keep-screenshots'], {}, 30_000);
    assert.equal(missing.code, 0, missing.output);
    assert.equal(JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8')).reused, 0);
    assert.ok(existsSync(screenshot));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify --resume remeasures legacy results instead of reporting a stale pass', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-legacy-'));
  const server = createServer((_req, res) => { res.writeHead(503); res.end(); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { base, file } = seedPage(dataDir, 'p1', { overall: 0.93,
      target: `http://127.0.0.1:${server.address().port}/p1` });
    const previous = readFileSync(file);
    const { code, output } = await runVerify(dataDir, ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '10x10']);
    assert.equal(code, 1, output);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.reused, 0, output);
    assert.equal(summary.measured, 0);
    assert.equal(summary.passed, false);
    const history = join(base, 'verify', '.resume-history');
    const archive = readdirSync(history).find(name => name.startsWith('page-'));
    assert.deepEqual(readFileSync(join(history, archive, 'verify.json')), previous);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify --resume rejects changed settings, verifier, evidence and session state', { timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-settings-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const html = '<!doctype html><html><body>local fixture</body></html>';
  let unavailable = false;
  const server = createServer((_req, res) => {
    res.writeHead(unavailable ? 503 : 200, { 'content-type': 'text/html' });
    res.end(html);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), html);
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${server.address().port}/` }));
    const args = ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '100x100'];
    const first = await runVerify(dataDir, args, {}, 30_000);
    assert.equal(first.code, 0, first.output);
    const file = join(base, 'verify', 'p1', 'verify.json');
    const diff = join(base, 'verify', 'p1', 'diff-100x100.png');
    const original = readFileSync(file);
    const originalDiff = readFileSync(diff);
    unavailable = true;
    const cases = [
      { name: 'allow-bounded', args: [...args, '--allow-bounded'] },
      { name: 'keep-screenshots', args: [...args, '--keep-screenshots'] },
      { name: 'interactions', args: ['x.test', '--all', '--resume', '--interactions', '--viewports', '100x100'] },
      { name: 'viewport', args: ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '120x100'] },
      { name: 'jobs', args: [...args, '--jobs', '2'] },
      { name: 'settle timeout', args, env: { HEIMDALL_VERIFY_SETTLE_TIMEOUT_MS: '3000' } },
      { name: 'verifier', args, change: () => {
        const record = JSON.parse(original);
        record.resumeCache.verifier = 'outdated';
        writeFileSync(file, JSON.stringify(record));
      } },
      { name: 'measurement proof', args, change: () => {
        const record = JSON.parse(original);
        delete record.measurementProof;
        writeFileSync(file, JSON.stringify(record));
      } },
      { name: 'score changed', args, change: () => {
        const record = JSON.parse(original);
        record.overall = 0.5;
        writeFileSync(file, JSON.stringify(record));
      } },
      { name: 'evidence', args, change: () => writeFileSync(diff, 'changed') },
      { name: 'damaged record', args, change: () => {
        const record = JSON.parse(original);
        record.viewports = {};
        writeFileSync(file, JSON.stringify(record));
      } },
      { name: 'session', args, change: () => {
        mkdirSync(join(dataDir, 'workspace', '127.0.0.1'), { recursive: true });
        writeFileSync(join(dataDir, 'workspace', '127.0.0.1', 'session.json'), '{"cookies":[],"origins":[]}');
      } },
    ];
    for (const item of cases) {
      writeFileSync(file, original);
      writeFileSync(diff, originalDiff);
      item.change?.();
      const result = await runVerify(dataDir, item.args, item.env ?? {}, 30_000);
      assert.equal(result.code, 1, `${item.name}: ${result.output}`);
      const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
      assert.equal(summary.reused, 0, `${item.name}: ${result.output}`);
      assert.equal(summary.measured, 0, item.name);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify --resume does not cache clones that request outside their directory', { timeout: 45_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-external-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  let html = '';
  let unavailable = false;
  const server = createServer((req, res) => {
    if (req.url === '/image.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    } else {
      res.writeHead(unavailable ? 503 : 200, { 'content-type': 'text/html' });
      res.end(html);
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    html = `<!doctype html><html><body><img src="${origin}/image.svg" width="10" height="10"></body></html>`;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), html);
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: origin + '/' }));
    const args = ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '100x100'];
    const first = await runVerify(dataDir, args, {}, 30_000);
    assert.equal(first.code, 0, first.output);
    const record = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(record.resumeCache, undefined);
    assert.equal(record.measurementProof, undefined);
    unavailable = true;
    const second = await runVerify(dataDir, args, {}, 30_000);
    assert.equal(second.code, 1, second.output);
    assert.equal(JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8')).reused, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify --resume reruns interaction checks instead of reusing untracked replay dependencies', { timeout: 45_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-interactions-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const html = '<!doctype html><html><body>local fixture</body></html>';
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), html);
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${server.address().port}/` }));
    const args = ['x.test', '--all', '--resume', '--interactions', '--viewports', '100x100'];
    for (let i = 0; i < 2; i++) {
      const result = await runVerify(dataDir, args, {}, 30_000);
      assert.equal(result.code, 0, result.output);
      assert.equal(JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8')).reused, 0);
      const record = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
      assert.equal(record.resumeCache, undefined);
      assert.ok(record.measurementProof?.inputs, 'visual proof remains available when replay cannot be cached');
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('verify --resume leaves previous evidence intact when archiving fails', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-archive-fail-'));
  try {
    const { base, file } = seedPage(dataDir, 'p1', { target: 'http://127.0.0.1:1/p1' });
    const previous = readFileSync(file);
    mkdirSync(join(base, 'verify', 'p1', 'diff-invalid.png'));
    const result = await runVerify(dataDir, ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '10x10']);
    assert.equal(result.code, 1, result.output);
    assert.deepEqual(readFileSync(file), previous);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.match(summary.failedPages[0].error, /could not be archived/);
    assert.equal(summary.passed, false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('verify --resume 对没测成的页仍然重跑', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-failed-'));
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<h1>source unavailable</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    seedPage(dataDir, 'p1', {
      measured: false,
      target: `http://127.0.0.1:${port}/p1`,
    });
    const { output } = await runVerify(dataDir, ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '10x10'], {}, 60_000);
    const summary = JSON.parse(readFileSync(join(dataDir, 'workspace', 'x.test', 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.reused, 0, output);
    assert.equal(summary.measured, 0);
    assert.equal(summary.untested, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('--resume 只能与 --all 一起用', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-resume-single-'));
  try {
    const { code, output } = await runVerify(dataDir, ['x.test', 'p1', '--resume']);
    assert.equal(code, 2, output);
    assert.match(output, /--resume 只能与 --all/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// ---------- 有界置信度（--allow-bounded） ----------

/**
 * 402 页卡在"未测到"的根因不是像素算法不行，而是很多页面永远等不到完全收敛：
 * 长轮询、埋点心跳、统计信标会让请求集合一直非空。但这类页的**版面早就定住了**，
 * 截下来就是终态。--allow-bounded 把它们按"有界置信度"计入分数；
 * 而版面还在动、滚动后还在长高的页，无论开不开都必须拦下 —— 那是中间态。
 */
function pollServer() {
  return createServer((req, res) => {
    if (req.url === '/poll') return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><div style="height:1000px"></div>
      <script>fetch('/poll').catch(() => {})</script></body></html>`);
  });
}

test('--allow-bounded 把"版面已定、请求未结束"的页按有界置信度计入', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-bounded-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const server = pollServer();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><div style="height:1000px"></div></body></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/p1` }));

    const { code, output } = await runVerify(dataDir,
      ['x.test', '--all', '--allow-bounded', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 30_000);
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.allowBounded, true, output);
    assert.equal(summary.measured, 1, output);
    assert.equal(summary.bounded, 1, output);
    assert.equal(summary.untested, 0);
    assert.equal(summary.passed, true, output);
    assert.equal(code, 0, output);

    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.measured, true);
    assert.equal(result.confidence, 'bounded');
    assert.equal(typeof result.overall, 'number');
    assert.ok(result.confidenceReasons.some(r => /长轮询|请求/.test(r)), JSON.stringify(result.confidenceReasons));
    assert.equal(result.resumeCache?.options.allowBounded, true);

    const strict = await runVerify(dataDir,
      ['x.test', '--all', '--resume', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 30_000);
    assert.equal(strict.code, 1, strict.output);
    const strictSummary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(strictSummary.reused, 0, strict.output);
    assert.equal(strictSummary.measured, 0, strict.output);
    assert.equal(strictSummary.passed, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('--allow-bounded 也不会放行"版面还在变"的页', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-bounded-growing-'));
  const base = join(dataDir, 'workspace', 'x.test');
  const page = join(base, 'pages', 'p1');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url?.startsWith('/static/')) {
      res.end('<!doctype html><html><body><div style="height:3000px"></div></body></html>');
      return;
    }
    res.end(`<!doctype html><html><body><div id="content" style="height:3000px"></div>
      <script>
        let height = 3000;
        addEventListener('scroll', () => {
          if (scrollY > height - 1200) {
            height += 1000;
            document.querySelector('#content').style.height = height + 'px';
          }
        });
      </script></body></html>`);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><div style="height:3000px"></div></body></html>');
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${port}/source` }));

    const { code, output } = await runVerify(dataDir,
      ['x.test', '--all', '--allow-bounded', '--no-interactions', '--viewports', '100x100'],
      { HEIMDALL_PORT: String(port) }, 60_000);
    assert.equal(code, 1, output, '版面还在动 → 门禁必须红');
    const summary = JSON.parse(readFileSync(join(base, 'verify', 'verify-summary.json'), 'utf8'));
    assert.equal(summary.measured, 0, output);
    assert.equal(summary.bounded, 0);
    assert.equal(summary.untested, 1);
    const result = JSON.parse(readFileSync(join(base, 'verify', 'p1', 'verify.json'), 'utf8'));
    assert.equal(result.confidence, 'none');
    assert.equal(result.measured, false);
    assert.match(result.error, /scroll|增长|版面/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
