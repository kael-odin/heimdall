#!/usr/bin/env node
/**
 * sandbox/serve — 沙盒改造台：在克隆页上改 HTML/CSS，与原版实时对比
 *
 * 用法:
 *   node src/sandbox/serve.mjs <host> <page> [--port 8090] [--reset]
 *
 * 路由:
 *   /              编辑器（HTML/CSS + 实时预览 + 相似度对比）
 *   /preview       注入沙盒 CSS 后的预览
 *   /clone/**      原克隆页静态资源
 *   /api/state /api/save /api/diff
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { sandboxPaths, injectSandboxEdits, renderEditorPage } from './core.mjs';
import { comparePngBuffers } from '../verify/compare.mjs';
import { makeArgs } from '../args.mjs';
import { freezeCss } from '../freeze.mjs';

const argv = process.argv.slice(2);
const { argOf } = makeArgs(argv);
const host = argv[0];
const page = argv[1];
const PORT = Number(argOf('port', 8090));
const RESET = argv.includes('--reset');
if (!host || !page) { console.error('usage: node src/sandbox/serve.mjs <host> <page> [--port 8090] [--reset]'); process.exit(2); }

const CLONE = join(WORKSPACE, host, 'pages', page, 'clone');
if (!existsSync(join(CLONE, 'index.html'))) { console.error('clone page not found:', CLONE); process.exit(1); }
const P = sandboxPaths(host, page);
mkdirSync(P.dir, { recursive: true });
if (RESET || !existsSync(P.html)) copyFileSync(join(CLONE, 'index.html'), P.html);
if (!existsSync(P.css)) writeFileSync(P.css, '');
writeFileSync(P.meta, JSON.stringify({ host, page, cloneDir: CLONE, createdAt: new Date().toISOString() }, null, 2));
const ORIGINAL_HTML = readFileSync(join(CLONE, 'index.html'), 'utf8');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4' };
const mimeOf = (f) => MIME[extname(f).toLowerCase()] ?? 'application/octet-stream';
const send = (res, code, body, type = 'text/plain; charset=utf-8') => { const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache' }); res.end(buf); };
const sendFile = (res, file) => { if (!file || !existsSync(file)) return false; try { if (!statSync(file).isFile()) return false; } catch { return false; } send(res, 200, readFileSync(file), mimeOf(file)); return true; };
const safeJoin = (root, rel) => { const f = normalize(join(root, rel)); const r = relative(root, f); return r && !r.startsWith('..') && !isAbsolute(r) ? f : null; };
const FREEZE = freezeCss();

async function shoot(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await p.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await p.evaluate(() => document.fonts?.ready).catch(() => {});
    await p.addStyleTag({ content: FREEZE });
    await p.waitForTimeout(800);
    try { return await p.screenshot({ fullPage: true, timeout: 60_000 }); }
    catch { return await p.screenshot({ timeout: 30_000 }); }
  } finally { await ctx.close().catch(() => {}); }
}

let diffBusy = false;
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(u.pathname);
  if (pathname === '/') return send(res, 200, renderEditorPage({ host, page, port: PORT }), 'text/html; charset=utf-8');
  if (pathname === '/api/state') {
    return send(res, 200, JSON.stringify({ host, page, originalHtml: ORIGINAL_HTML, html: readFileSync(P.html, 'utf8'), css: readFileSync(P.css, 'utf8') }), 'application/json; charset=utf-8');
  }
  if (pathname === '/api/save' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        if (typeof j.html === 'string') writeFileSync(P.html, j.html);
        if (typeof j.css === 'string') writeFileSync(P.css, j.css);
        send(res, 200, JSON.stringify({ ok: true }), 'application/json');
      } catch (e) { send(res, 400, JSON.stringify({ ok: false, error: String(e).slice(0, 200) }), 'application/json'); }
    });
    return;
  }
  if (pathname === '/preview') {
    const html = readFileSync(P.html, 'utf8');
    const css = readFileSync(P.css, 'utf8');
    return send(res, 200, injectSandboxEdits(html, css), 'text/html; charset=utf-8');
  }
  if (pathname.startsWith('/clone/')) {
    const file = safeJoin(CLONE, pathname.slice('/clone/'.length));
    if (sendFile(res, file)) return;
    return send(res, 404, 'not found');
  }
  if (pathname === '/api/diff' && req.method === 'POST') {
    if (diffBusy) return send(res, 429, JSON.stringify({ error: 'busy' }), 'application/json');
    diffBusy = true;
    try {
      const browser = await chromium.launch();
      let a, b;
      try {
        a = await shoot(browser, `http://127.0.0.1:${PORT}/clone/index.html`);
        b = await shoot(browser, `http://127.0.0.1:${PORT}/preview`);
      } finally { await browser.close(); }
      const cmp = comparePngBuffers(a, b);
      writeFileSync(P.diff, cmp.diffPng);
      const score = { score: cmp.score, mismatched: cmp.mismatched, heightDelta: cmp.heightDelta, width: cmp.width, height: cmp.height, at: new Date().toISOString() };
      writeFileSync(P.score, JSON.stringify(score, null, 2));
      return send(res, 200, JSON.stringify(score), 'application/json; charset=utf-8');
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e).slice(0, 200) }), 'application/json');
    } finally { diffBusy = false; }
  }
  if (pathname === '/diff.png') { if (sendFile(res, P.diff)) return; return send(res, 404, 'no diff yet'); }
  if (pathname === '/score.json') { if (sendFile(res, P.score)) return; return send(res, 404, 'no score yet'); }
  return send(res, 404, 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`[sandbox] ${host}/${page} -> http://127.0.0.1:${PORT}`));
