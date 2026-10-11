#!/usr/bin/env node
/**
 * extract-components — 从克隆页抽取可复用组件（header/hero/pricing/faq/footer/cta）
 *
 * 用法:
 *   node src/extract/extract-components.mjs <host> [--pages 2] [--max 12]
 *
 * 产物（workspace/<host>/design/components/）:
 *   <page>-<key>.html   独立预览（outerHTML + 命中 CSS + :root 变量）
 *   components.json     组件清单（tag/classes/规则数/字节/来源页）
 *   components.html     组件画廊（iframe 预览）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';
import { componentCandidates, matchingCssRules, renderComponentPreview, renderGallery } from './components.mjs';
import { emit } from '../emit.mjs';

const log = (...a) => console.error('[components]', ...a);

const argv = process.argv.slice(2);
const host = argv.find(a => !a.startsWith('--'));
const getNum = (n, d) => { const i = argv.indexOf('--' + n); if (i > -1 && argv[i + 1]) return Number(argv[i + 1]); const eq = argv.find(a => a.startsWith('--' + n + '=')); return eq ? Number(eq.split('=')[1]) : d; };
if (!host) { console.error('usage: node src/extract/extract-components.mjs <host> [--pages 2] [--max 12]'); process.exit(2); }

const PAGES = join(WORKSPACE, host, 'pages');
if (!existsSync(PAGES)) { console.error('no pages for host:', host); process.exit(1); }
const PAGE_LIMIT = Math.max(1, Math.min(getNum('pages', 2), 10));
const MAX = Math.max(1, Math.min(getNum('max', 12), 40));

const candidates = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'dom.html')) && existsSync(join(PAGES, n, 'cssom.css')));
const ordered = ['home', 'pricing', ...candidates.filter(n => !['home', 'pricing'].includes(n))].filter(n => candidates.includes(n)).slice(0, PAGE_LIMIT);
if (!ordered.length) { console.error('no dom.html/cssom.css found'); process.exit(1); }
log('pages:', ordered.join(', '));

const outDir = join(WORKSPACE, host, 'design', 'components');
mkdirSync(outDir, { recursive: true });
const components = [];
for (const page of ordered) {
  const dom = readFileSync(join(PAGES, page, 'dom.html'), 'utf8');
  const css = readFileSync(join(PAGES, page, 'cssom.css'), 'utf8');
  const found = componentCandidates(dom, { max: Math.ceil(MAX / ordered.length) + 2 });
  for (const c of found) {
    const match = matchingCssRules(css, c);
    const file = `${page}-${c.key}.html`;
    // 预览素材路径：snippet/CSS 里的 assets|styles 相对引用 → 指回该页 clone 目录
    const relBase = '../../pages/' + page + '/clone/';
    const fixRefs = (s) => String(s)
      .replace(/(src|srcset|poster)="assets\//g, '$1="' + relBase + 'assets/')
      .replace(/url\((['"]?)\.\.\/assets\//g, 'url($1' + relBase + 'assets/')
      .replace(/url\((['"]?)assets\//g, 'url($1' + relBase + 'assets/')
      .replace(/url\((['"]?)\.\.\/styles\//g, 'url($1' + relBase + 'styles/')
      // 根相对引用（/img/...、/fonts/...）→ 指回该页 clone 目录（离线/HTTP 都正确）
      .replace(/(src|srcset|poster|href)="\/(?!\/)/g, '$1="' + relBase)
      .replace(/url\((['"]?)\/(?!\/)/g, 'url($1' + relBase);
    const previewHtml = fixRefs(c.html);
    writeFileSync(join(outDir, file), renderComponentPreview({ ...c, html: previewHtml }, fixRefs(match.css), { host }));
    components.push({
      page, key: c.key, name: c.name, tag: c.tag, id: c.id, classes: c.classes,
      selector: (c.id ? '#' + c.id : c.classes.length ? '.' + c.classes[0] : c.tag),
      text: c.text, bytes: c.bytes, matchedRules: match.rules, matchedCssBytes: match.bytes,
      file, html: c.html,
    });
    log(`  ${page}/${c.key}: <${c.tag}> rules=${match.rules} css=${(match.bytes / 1024).toFixed(0)}KB html=${(c.bytes / 1024).toFixed(0)}KB`);
  }
}

writeFileSync(join(outDir, 'components.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), pages: ordered, components: components.map(c => ({ ...c, html: undefined })) }, null, 2));
writeFileSync(join(outDir, 'components.html'), renderGallery(host, components));
log(`components ${components.length} -> ${join(outDir, 'components.html')}`);
emit({ kind: 'components-done', host, pages: ordered.length, components: components.length, path: join(outDir, 'components.html') });
