/**
 * agent/gate/baseline — 正式基线供给与体检（E7-19，PRD 05 §1.5）
 *
 * 正式裁判（验收 Mirror）需要「基线入口 URL」。镜像不能直接交给它：
 *   · 引擎 /static/ 在设了令牌时对隔离上下文返回 401（Ph0 S4）；
 *   · clone-preview-server 给 HTML 加 CSP sandbox，字体、serviceWorker、cssRules 全被拦，基线不健康。
 * 所以这里起一个**只读、回环、随机端口、无令牌、不加任何 CSP** 的静态服务，运行结束即关。
 *
 * 镜像还不干净时（残留第三方嵌入、本地 404），先体检，再生成「正式基线副本」：
 * 去掉外部请求与断链引用，改动逐条写进报告；副本仍不健康就记 `blocked` 并写明原因。
 * blocked 不是失败：它明确告诉调用方这一维没法判，而不是判成不过。
 */
import { createReadStream, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parse, serialize } from 'parse5';
import { isInside } from '../../paths.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';
import { sha256 } from '../ids.mjs';
import { isSecretPath } from '../secrets.mjs';
import { agentDir, mirrorEntry, requireMirror } from '../workspace.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};

/** 1×1 透明 GIF：用在被摘掉的外部图片/背景上，保持盒子尺寸，但不发请求 */
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function safeStat(root, file) {
  const rel = relative(root, file);
  if ((rel && !isInside(root, file)) || isSecretPath(rel)) return null;
  try {
    let current = root;
    let stat = lstatSync(current);
    if (stat.isSymbolicLink()) return null;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      stat = lstatSync(current);
      if (stat.isSymbolicLink()) return null;
    }
    return stat;
  } catch { return null; }
}

/** 只读静态服务：根目录下任何普通文件都能读，秘密文件与目录穿越一律 404 */
export async function startBaselineServer(root, { host = '127.0.0.1' } = {}) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let file, stat;
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      let candidate = resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!isInside(base, candidate) && candidate !== base) { res.writeHead(404); res.end(); return; }
      stat = safeStat(base, candidate);
      if (stat?.isDirectory()) { candidate = join(candidate, 'index.html'); stat = safeStat(base, candidate); }
      if (!stat?.isFile()) { res.writeHead(404); res.end(); return; }
      file = candidate;
    } catch { res.writeHead(400); res.end(); return; }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    // 不写 Content-Security-Policy：sandbox 会让字体、worker、cssRules 全部失效（PRD 05 §1.5）
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, host, resolveListen); });
  const origin = `http://${host}:${server.address().port}`;
  return {
    origin,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); },
  };
}

/** 一个引用值是不是外部（会给别的源发请求） */
export function classifyRef(value) {
  const v = String(value ?? '').trim();
  if (!v || v.startsWith('#') || /^(?:data|blob|about|mailto|tel|javascript):/i.test(v)) return { kind: 'ignored' };
  if (v.startsWith('//')) return { kind: 'external', url: 'https:' + v };
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return /^https?:/i.test(v) ? { kind: 'external', url: v } : { kind: 'ignored' };
  return { kind: 'local' };
}

/** 本地引用对应的文件；路径跑出根目录、带协议或找不到文件时返回 null */
function localFile(root, docDir, value) {
  const pathPart = String(value).split(/[?#]/)[0];
  if (!pathPart) return null;
  try {
    const file = resolve(docDir, decodeURIComponent(pathPart));
    return isInside(root, file) && safeStat(root, file) ? file : null;
  } catch { return null; }
}

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const setAttr = (node, name, value) => { const a = node.attrs?.find(x => x.name === name); if (a) a.value = value; else (node.attrs ??= []).push({ name, value }); };
const dropAttr = (node, name) => { if (node.attrs) node.attrs = node.attrs.filter(a => a.name !== name); };

const RESOURCE_ATTRS = {
  script: ['src'], img: ['src'], source: ['src'], video: ['src', 'poster'], audio: ['src'],
  track: ['src'], embed: ['src'], object: ['data'], iframe: ['src'], link: ['href'], input: ['src'],
};
/** 资源元素：引用没了就该整个摘掉（iframe 尤其：第三方嵌入会拖垮健康判定） */
const DROP_WHEN_EMPTY = new Set(['script', 'iframe', 'link']);

/** 会触发请求的 rel：只有这些 <link> 需要为「外部」动手；canonical / alternate 之类不会发请求，留着 */
const FETCHING_RELS = new Set(['stylesheet', 'icon', 'shortcut', 'apple-touch-icon', 'mask-icon', 'manifest',
  'preload', 'modulepreload', 'prefetch', 'prerender', 'preconnect', 'dns-prefetch']);
const fetches = (node) => {
  const rel = attr(node, 'rel');
  return rel ? String(rel).toLowerCase().split(/\s+/).some(t => FETCHING_RELS.has(t)) : false;
};

/** 递归清洗一个 HTML 文档；返回新 HTML 与改动清单 */
export function sanitizeHtml(html, { root, file, log, normalizeLinks = false }) {
  const doc = parse(String(html));
  const docDir = resolve(file, '..');
  const changes = [];
  const note = (kind, detail) => { changes.push({ kind, detail }); };
  const checkLocal = (value) => localFile(root, docDir, value) !== null;

  const cleanSrcset = (set) => {
    const kept = String(set).split(',').map(part => part.trim()).filter(Boolean).map(part => {
      const [url, ...rest] = part.split(/\s+/);
      const c = classifyRef(url);
      return c.kind === 'external' ? null : (c.kind === 'local' && !checkLocal(url) ? null : [url, ...rest].join(' '));
    }).filter(Boolean);
    return kept.length ? kept.join(', ') : null;
  };

  const visit = (node) => {
    if (!node.childNodes) return;
    const next = [];
    for (const child of node.childNodes) {
      if (child.tagName === 'link' && fetches(child)) {
        const href = attr(child, 'href');
        const c = classifyRef(href);
        if (c.kind === 'external' || (c.kind === 'local' && !checkLocal(href))) {
          note(c.kind === 'external' ? 'external_link_removed' : 'broken_link_removed', href);
          continue;
        }
      }
      if (child.tagName === 'a' && normalizeLinks) {
        const href = attr(child, 'href');
        const c = classifyRef(href);
        if (c.kind === 'external') {
          try {
            const u = new URL(c.url);
            setAttr(child, 'href', u.pathname + u.search + u.hash);
            note('anchor_normalized', href);
          } catch { /* 解析不了就原样留着 */ }
        }
      }
      if (child.tagName === 'base' && classifyRef(attr(child, 'href')).kind === 'external') {
        setAttr(child, 'href', './'); note('base_neutralized', attr(child, 'href'));
      }
      if (child.tagName === 'iframe') {
        const src = attr(child, 'src');
        const c = classifyRef(src);
        if (c.kind === 'external' || (c.kind === 'local' && !checkLocal(src))) {
          note(c.kind === 'external' ? 'external_frame_removed' : 'broken_frame_removed', src);
          continue;
        }
      }
      if (child.tagName === 'script' && attr(child, 'src') !== undefined) {
        const src = attr(child, 'src');
        const c = classifyRef(src);
        if (c.kind === 'external' || (c.kind === 'local' && !checkLocal(src))) {
          note(c.kind === 'external' ? 'external_script_removed' : 'broken_script_removed', src);
          continue;
        }
      }
      const names = RESOURCE_ATTRS[child.tagName];
      if (names && child.tagName !== 'link' && child.tagName !== 'iframe' && child.tagName !== 'script') {
        let emptied = false;
        for (const name of names) {
          const value = attr(child, name);
          if (value === undefined) continue;
          const c = classifyRef(value);
          if (c.kind === 'external') { setAttr(child, name, BLANK_PIXEL); note('external_asset_replaced', value); }
          else if (c.kind === 'local' && !checkLocal(value)) {
            if (DROP_WHEN_EMPTY.has(child.tagName)) { emptied = true; } else { setAttr(child, name, BLANK_PIXEL); }
            note('broken_asset_replaced', value);
          }
        }
        if (emptied) continue;
        if (attr(child, 'srcset') !== undefined) {
          const kept = cleanSrcset(attr(child, 'srcset'));
          if (kept) setAttr(child, 'srcset', kept); else { dropAttr(child, 'srcset'); note('srcset_cleared', attr(child, 'srcset')); }
        }
      }
      if (attr(child, 'style') !== undefined && /url\(\s*['"]?(?:https?:)?\/\//i.test(attr(child, 'style'))) {
        setAttr(child, 'style', sanitizeCss(attr(child, 'style')).text);
        note('inline_style_url_cleared', child.tagName);
      }
      if (child.tagName === 'style' && child.childNodes?.length) {
        const r = sanitizeCss(child.childNodes.map(n => n.value ?? '').join(''));
        if (r.changed) { child.childNodes = [{ nodeName: '#text', value: r.text }]; note('style_block_cleaned', r.count); }
      }
      if (child.tagName === 'form' && classifyRef(attr(child, 'action')).kind === 'external') {
        dropAttr(child, 'action'); note('form_action_dropped', attr(child, 'action'));
      }
      visit(child);
      next.push(child);
    }
    node.childNodes = next;
  };
  visit(doc);
  const out = serialize(doc);
  for (const c of changes) log?.(`${file}: ${c.kind} ${String(c.detail).slice(0, 120)}`);
  return { html: out, changes };
}

/** CSS 里的外部 url() 与 @import：换成透明像素，既不请求也不改盒子 */
export function sanitizeCss(text) {
  let count = 0;
  let out = String(text)
    .replace(/@import\s+(?:url\()?['"]?(?:https?:)?\/\/[^;]*;/gi, () => { count++; return '/* external @import removed by heimdall baseline */'; })
    .replace(/url\(\s*(['"]?)(?:(?:https?:)?\/\/)[^)]*\)/gi, () => { count++; return `url(${BLANK_PIXEL})`; });
  return { text: out, changed: count > 0, count };
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 复制一份干净的基线副本：二进制原样拷，HTML/CSS 清洗；秘密文件不拷 */
export function copySanitizedBaseline(srcDir, destDir, { log, normalizeLinks = false } = {}) {
  const root = resolve(srcDir);
  const all = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      const rel = relative(root, p);
      if (isSecretPath(rel)) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(p); continue; }
      if (st.isFile()) all.push(p);
    }
  };
  walk(root);
  const changes = [];
  let copied = 0;
  for (const file of all) {
    const rel = file.slice(root.length + 1);
    const dest = join(destDir, rel);
    mkdirSync(resolve(dest, '..'), { recursive: true });
    const ext = extname(file).toLowerCase();
    if (ext === '.html' || ext === '.htm') {
      const r = sanitizeHtml(readFileSync(file, 'utf8'), { root, file, log, normalizeLinks });
      writeFileSync(dest, r.html);
      for (const c of r.changes) changes.push({ file: rel.replace(/\\/g, '/'), ...c });
    } else if (ext === '.css') {
      const r = sanitizeCss(readFileSync(file, 'utf8'));
      writeFileSync(dest, r.text);
      if (r.changed) changes.push({ file: rel.replace(/\\/g, '/'), kind: 'css_urls_cleared', detail: r.count });
    } else {
      writeFileSync(dest, readFileSync(file));
    }
    copied++;
  }
  return { copied, changes };
}

const localTo = (url, origin) => String(url).startsWith(origin + '/') || String(url) === origin;

/**
 * 体检：打开基线，记录外部请求、同源失败与脚本错误。
 * healthy = 导航成功 + 没有外部请求 + 没有同源 4xx/5xx 或请求失败。控制台错误只记警告。
 */
export async function probeBaseline(browser, url, { origin, settleMs = 1200, timeoutMs = 30_000 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const external = new Map(), failed = [], consoleErrors = [], pageErrors = [];
  let requests = 0;
  page.on('request', (req) => {
    requests++;
    const u = req.url();
    if (/^(?:data|blob|about):/i.test(u)) return;
    if (origin && localTo(u, origin)) return;
    try { const p = new URL(u); const key = p.host; const cur = external.get(key) ?? { host: key, count: 0, sample: u }; cur.count++; external.set(key, cur); }
    catch {}
  });
  page.on('response', (res) => { if (res.status() >= 400 && origin && localTo(res.url(), origin)) failed.push({ status: res.status(), url: res.url().slice(origin.length) }); });
  page.on('requestfailed', (req) => { if (origin && localTo(req.url(), origin)) failed.push({ status: null, url: req.url().slice(origin.length), error: req.failure()?.errorText ?? 'request failed' }); });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
  let navigation = null, doc = null;
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    navigation = res ? res.status() : null;
    await page.waitForTimeout(settleMs);
    doc = await page.evaluate(() => ({ title: document.title, height: Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0) }));
  } catch (error) {
    navigation = 'error';
    pageErrors.push(String(error?.message ?? error).slice(0, 200));
  }
  await ctx.close();
  const issues = [];
  if (navigation === 'error' || (navigation && navigation >= 400)) issues.push({ code: 'navigation_failed', severity: 'error', detail: navigation === 'error' ? pageErrors.at(-1) ?? 'navigation failed' : `HTTP ${navigation}` });
  for (const e of external.values()) issues.push({ code: 'external_request', severity: 'error', detail: `${e.host}（${e.count} 次）例：${e.sample.slice(0, 160)}` });
  for (const f of failed.slice(0, 20)) issues.push({ code: 'local_request_failed', severity: 'error', detail: `${f.status ?? 'ERR'} ${f.url}` });
  if (failed.length > 20) issues.push({ code: 'local_request_failed_more', severity: 'error', detail: `另有 ${failed.length - 20} 条` });
  if (pageErrors.length) issues.push({ code: 'page_error', severity: 'warn', detail: pageErrors[0] });
  if (consoleErrors.length) issues.push({ code: 'console_error', severity: 'warn', detail: consoleErrors[0] });
  const healthy = !issues.some(i => i.severity === 'error');
  return { healthy, issueCount: issues.length, issues,
    stats: { navigation, requests, document: doc, externalHosts: [...external.keys()].sort(), failed: failed.length, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length } };
}

/**
 * 准备正式基线：供一份 → 体检 → 不健康就做副本再体检。
 * @returns {Promise<{status:'healthy'|'sanitized'|'blocked', dir, entry, origin?, probe, sanitized?, reportPath, reason?}>}
 */
export async function prepareBaseline(browser, { siteId, page, viewport = 1440, stateDir = null } = {}) {
  const pageDir = requireMirror(siteId, page);
  const cloneDir = join(pageDir, 'clone');
  const entry = mirrorEntry(siteId, page, viewport);
  const entryRel = entry.startsWith('clone/') ? entry.slice('clone/'.length) : entry;
  const outDir = stateDir ?? join(agentDir(siteId), 'gate', page);
  mkdirSync(outDir, { recursive: true });

  const first = await withServer(cloneDir, (origin) => probeBaseline(browser, `${origin}/${entryRel}`, { origin }));
  const report = {
    schema: 'heimdall.baseline/1', siteId, page, generatedAt: new Date().toISOString(), viewport,
    source: { dir: cloneDir, entry: entryRel },
    serving: { loopback: true, randomPort: true, tokenFree: true, csp: 'none', readOnly: true },
    probe: first,
  };
  if (first.healthy) {
    report.status = 'healthy';
    report.dir = cloneDir;
    return finish(report, outDir);
  }
  // 不健康：生成正式基线副本（去掉外部请求与断链引用），再体检一次
  const copyDir = join(outDir, 'baseline');
  const copy = copySanitizedBaseline(cloneDir, copyDir);
  const second = await withServer(copyDir, (origin) => probeBaseline(browser, `${origin}/${entryRel}`, { origin }));
  report.sanitized = { dir: copyDir, files: copy.copied, changes: copy.changes };
  report.sanitizedProbe = second;
  report.status = second.healthy ? 'sanitized' : 'blocked';
  report.dir = second.healthy ? copyDir : cloneDir;
  if (!second.healthy) report.reason = '副本仍有外部请求或本地失败，这一维无法判定（不是失败）';
  return finish(report, outDir);
}

async function withServer(root, fn) {
  const server = await startBaselineServer(root);
  try { return await fn(server.origin); } finally { await server.close(); }
}

function finish(report, outDir) {
  const file = join(outDir, 'baseline.json');
  const body = JSON.stringify(report, null, 1);
  writeFileAtomic(file, body);
  return { ...report, reportPath: file, evidence: { uri: `file://${file.replace(/\\/g, '/')}`, sha256: sha256(body), bytes: body.length } };
}
