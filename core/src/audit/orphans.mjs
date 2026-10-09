#!/usr/bin/env node
/**
 * audit/orphans — 孤儿资产扫描：clone 内无任何引用的资产（疑似可回收）
 *
 * 判定：全站引用 token 集合精确包含资产相对路径，或同页 token 集合包含其 basename。
 * 产物: workspace/<host>/audit/orphans.json
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
const argv = process.argv.slice(2);
const host = argv.find(a => !a.startsWith('--'));
if (!host) { console.error('usage: node src/audit/orphans.mjs <host>'); process.exit(2); }
const base = join(WORKSPACE, host);
const pagesDir = join(base, 'pages');
if (!existsSync(pagesDir)) { console.error('no pages for host:', host); process.exit(1); }

const TEXT_RE = /\.(html?|css|js|mjs|json|xml|svg)$/i;
const REF_RE = /(?:assets|styles)\/[A-Za-z0-9._-]+/g;
const MAX_TEXT = 3 * 1024 * 1024;
const toks = (t) => [...t.matchAll(REF_RE)].map(m => m[0]);

const globalRefs = new Set();
const pageAssets = new Map();
for (const page of readdirSync(pagesDir).sort()) {
  const cloneDir = join(pagesDir, page, 'clone');
  if (!existsSync(cloneDir)) continue;
  const refs = new Set();
  const bases = new Set();
  const assets = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      const rel = relative(cloneDir, p).split('\\').join('/');
      if (TEXT_RE.test(n) && st.size <= MAX_TEXT) {
        try {
          for (const t of toks(readFileSync(p, 'utf8'))) { refs.add(t); globalRefs.add(t); bases.add(t.split('/').pop()); }
        } catch {}
      }
      if (rel.startsWith('assets/') || rel.startsWith('styles/')) assets.push({ p, rel, size: st.size });
    }
  };
  walk(cloneDir);
  pageAssets.set(page, { refs, bases, assets });
}

let total = 0, orphanCount = 0, orphanBytes = 0, referencedBytes = 0;
const pages = [];
const allOrphanPaths = [];
for (const [page, { refs, bases, assets }] of pageAssets) {
  const orphans = [];
  for (const a of assets) {
    total++;
    const b = a.rel.split('/').pop();
    const used = globalRefs.has(a.rel) || refs.has(a.rel) || bases.has(b);
    if (used) { referencedBytes += a.size; continue; }
    orphanCount++; orphanBytes += a.size;
    const op = relative(WORKSPACE, a.p).split('\\').join('/');
    orphans.push({ path: op, page, size: a.size });
    allOrphanPaths.push(op);
  }
  if (orphans.length) pages.push({ page, count: orphans.length, bytes: orphans.reduce((n, o) => n + o.size, 0), items: orphans.slice(0, 60) });
}
pages.sort((a, b) => b.bytes - a.bytes);
const report = { host, generatedAt: new Date().toISOString(), total, referenced: total - orphanCount, orphans: orphanCount, orphanBytes, referencedBytes, pages, orphanPaths: allOrphanPaths };
const outDir = join(base, 'audit');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'orphans.json'), JSON.stringify(report, null, 2));
emit({ kind: 'orphans-done', host, total, orphans: orphanCount, orphanBytes });
console.log('[orphans] host=' + host + ' total=' + total + ' orphans=' + orphanCount + ' bytes=' + (orphanBytes / 1048576).toFixed(1) + 'MB -> audit/orphans.json');
