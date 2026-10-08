#!/usr/bin/env node
/**
 * smoke-forge — 端到端冒烟：本地 fixture 站点 → recon → forge → 产物断言 → 安全断言
 *
 * 设计目标：
 *   - 不碰外网、不碰真实 workspace（HEIMDALL_DATA_DIR = 临时目录）
 *   - 不调用 LLM（HEIMDALL_LLM=0）
 *   - 使用随机端口，可与用户正在运行的 :8900/:5173 并存
 *
 * 用法: node scripts/smoke-forge.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import assert from 'node:assert/strict';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_DIR = join(CORE, 'test', 'fixtures', 'site');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const log = (...a) => console.log('[smoke]', ...a);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(FIXTURE_DIR, rel.replace(/^\/+/, ''));
      if (!file.startsWith(FIXTURE_DIR) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - start > timeout) throw new Error('timeout waiting for ' + label);
    await new Promise(r => setTimeout(r, interval));
  }
}

async function postJson(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** 读取 SSE，直到 exit 事件（引擎会先重放历史事件） */
async function waitExit(base, taskId, timeoutMs = 240_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/events?task=${taskId}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.kind === 'exit') return ev;
      }
    }
    throw new Error('SSE ended without exit event');
  } finally { clearTimeout(timer); }
}

async function main() {
  const { server: fixture, port: fixturePort } = await startFixtureServer();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-smoke-'));
  log('fixture :' + fixturePort, '| engine :' + port, '| data', dataDir);

  const engine = spawn(process.execPath, ['src/engine-server.mjs', String(port)], {
    cwd: CORE,
    env: {
      ...process.env,
      HEIMDALL_DATA_DIR: dataDir,
      HEIMDALL_HOST: '127.0.0.1',
      HEIMDALL_LLM: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  engine.stdout.on('data', d => { engineLog += d; });
  engine.stderr.on('data', d => { engineLog += d; });

  try {
    await waitFor(async () => (await fetch(base + '/api/status')).ok, { label: 'engine boot', timeout: 20_000 });
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.bind, '127.0.0.1', 'engine must bind to localhost by default');

    // 1) recon
    const recon = await postJson(base, '/api/recon', { url: `http://127.0.0.1:${fixturePort}/`, maxPages: 5 });
    assert.equal(recon.status, 200, 'recon must start: ' + JSON.stringify(recon.body));
    const reconExit = await waitExit(base, recon.body.taskId, 120_000);
    assert.equal(reconExit.status, 'done', 'recon exit status');

    const atlas = await (await fetch(`${base}/api/atlas/${recon.body.taskId}`)).json();
    assert.ok(atlas.nodes.length >= 2, `atlas should discover >=2 pages, got ${atlas.nodes.length}`);
    assert.equal(atlas.status, 'ok');

    // 2) forge（hostPost=false：批量语义，站点级汇总由调用方统一跑）
    const forge = await postJson(base, '/api/forge', { url: `http://127.0.0.1:${fixturePort}/`, hostPost: false });
    assert.equal(forge.status, 200, 'forge must start: ' + JSON.stringify(forge.body));
    const forgeExit = await waitExit(base, forge.body.taskId, 240_000);
    assert.equal(forgeExit.status, 'done', 'forge exit status (engine log tail: ' + engineLog.slice(-400) + ')');

    // 3) 产物断言
    const pageDir = join(dataDir, 'workspace', '127.0.0.1', 'pages', 'home');
    const cloneHtml = join(pageDir, 'clone', 'index.html');
    const scorePath = join(pageDir, 'score.json');
    assert.ok(existsSync(cloneHtml), 'clone/index.html must exist: ' + cloneHtml);
    assert.ok(existsSync(scorePath), 'score.json must exist: ' + scorePath);
    const score = JSON.parse(readFileSync(scorePath, 'utf8'));
    assert.ok(score.pixel >= 0.5, `pixel score too low: ${score.pixel}`);
    assert.ok(score.dom.dom >= 0.9, `dom score too low: ${score.dom.dom}`);
    const html = readFileSync(cloneHtml, 'utf8');
    assert.ok(html.includes('styles/cssom.css'), 'clone must reference the captured CSSOM');
    assert.ok(!/<script\b/i.test(html), 'static clone must strip scripts');
    const assetMap = JSON.parse(readFileSync(join(pageDir, 'asset-map.json'), 'utf8'));
    assert.ok((assetMap.resources ?? []).some(r => (r.kinds ?? []).includes('icon')), 'asset-map must record the icon resource');
    const iconMatch = /<link[^>]+rel="icon"[^>]*href="(assets\/[^"]+)"/i.exec(html);
    assert.ok(iconMatch, 'favicon must be localized in the static clone');
    assert.ok(existsSync(join(pageDir, 'clone', iconMatch[1])), 'localized favicon file must exist: ' + iconMatch[1]);

    // 4) 安全断言
    const evil = await fetch(base + '/px/evil.example/x');
    assert.equal(evil.status, 403, 'proxy must reject non-workspace hosts');
    const lmEvil = await fetch(base + '/lm/evil.example/x');
    assert.equal(lmEvil.status, 403, 'live mirror must reject non-workspace hosts');
    const cloneUrl = `${base}/static/127.0.0.1/pages/home/clone/index.html`;
    assert.equal((await fetch(cloneUrl)).status, 200, 'clone page must be served');

    // 5) 任务清单
    const jobs = await (await fetch(base + '/api/jobs')).json();
    assert.ok(jobs.jobs.length >= 2, 'jobs endpoint should list recon + forge');
    assert.ok(jobs.jobs.every(j => ['done', 'failed', 'cancelled', 'running'].includes(j.status)));

    // 6) SEO 审计（复用同一 fixture + 临时数据目录）
    const audit = await postJson(base, '/api/audit', { url: `http://127.0.0.1:${fixturePort}/`, maxPages: 5 });
    assert.equal(audit.status, 200, 'audit must start: ' + JSON.stringify(audit.body));
    const auditExit = await waitExit(base, audit.body.taskId, 240_000);
    assert.equal(auditExit.status, 'done', 'audit exit status (engine log tail: ' + engineLog.slice(-500) + ')');
    const seoJson = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
    assert.ok(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.html')), 'seo.html must exist');
    assert.ok(seoJson.pages.length >= 2, 'audit should cover >=2 pages, got ' + seoJson.pages.length);
    assert.ok(seoJson.score > 0, 'audit score should be > 0');

    log('PASS — recon pages =', atlas.nodes.length, '| visual =', (score.pixel * 100).toFixed(1) + '%', '| dom =', (score.dom.dom * 100).toFixed(1) + '%', '| seo =', seoJson.score, '(', seoJson.summary.issues, 'issues )');
  } finally {
    engine.kill('SIGTERM');
    fixture.close();
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error('[smoke] FAIL —', e.message); process.exit(1); });
