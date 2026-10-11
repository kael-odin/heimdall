#!/usr/bin/env node
/**
 * extract-tokens — 站点设计 token 提取（颜色/字体/字号/间距/圆角/阴影/断点/CSS 变量）
 *
 * 用法:
 *   node src/extract/extract-tokens.mjs <host> [--pages 5] [--page <name>]
 *
 * 产物（workspace/<host>/design/）:
 *   tokens.json   结构化 token（含使用频次）
 *   tokens.css    可直接引用的 CSS 变量文件
 *   tokens.html   可视化预览（色板/字阶/间距/圆角/阴影/断点/原生变量）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';
import { extractTokens, buildTokensCss, renderTokensHtml, topEntries } from './tokens.mjs';
import { emit } from '../emit.mjs';
import { makeArgs } from '../args.mjs';

const log = (...a) => console.error('[tokens]', ...a);

const argv = process.argv.slice(2);
const { num } = makeArgs(argv);
const host = argv.find(a => !a.startsWith('--'));
const onlyPage = (() => { const i = argv.indexOf('--page'); return i > -1 ? argv[i + 1] : null; })();
if (!host) { console.error('usage: node src/extract/extract-tokens.mjs <host> [--pages 5] [--page <name>]'); process.exit(2); }

const PAGES = join(WORKSPACE, host, 'pages');
if (!existsSync(PAGES)) { console.error('no pages for host:', host); process.exit(1); }
const N = Math.max(1, Math.min(num('pages', 5), 30));

const candidates = readdirSync(PAGES)
  .filter(n => existsSync(join(PAGES, n, 'cssom.css')))
  .filter(n => !onlyPage || n === onlyPage)
  .map(n => {
    let pageType = '';
    try { pageType = JSON.parse(readFileSync(join(PAGES, n, 'intel', 'semantic.json'), 'utf8')).pageType ?? ''; } catch {}
    const priority = ['home', 'pricing'].includes(n) ? -1 : /定价|营销/.test(pageType) ? 0 : 2;
    return { n, pageType, priority };
  })
  .sort((a, b) => a.priority - b.priority || a.n.localeCompare(b.n))
  .slice(0, N);
if (!candidates.length) { console.error('no cssom.css found under', PAGES); process.exit(1); }

log('pages:', candidates.map(c => c.n).join(', '));
const css = candidates.map(c => `/* ==== page: ${c.n} (${c.pageType || 'n/a'}) ==== */\n` + readFileSync(join(PAGES, c.n, 'cssom.css'), 'utf8')).join('\n');
const tokens = extractTokens(css);

const outDir = join(WORKSPACE, host, 'design');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'tokens.json'), JSON.stringify({
  host, generatedAt: new Date().toISOString(), pages: candidates.map(c => c.n),
  summary: {
    colors: Object.keys(tokens.colors).length, fontFamilies: Object.keys(tokens.fontFamilies).length,
    fontSizes: Object.keys(tokens.fontSizes).length, spacings: Object.keys(tokens.spacings).length,
    radii: Object.keys(tokens.radii).length, shadows: Object.keys(tokens.shadows).length,
    breakpoints: Object.keys(tokens.breakpoints).length, variables: Object.keys(tokens.variables).length,
  },
  tokens,
}, null, 2));
writeFileSync(join(outDir, 'tokens.css'), buildTokensCss(tokens, { host }));
writeFileSync(join(outDir, 'tokens.html'), renderTokensHtml(host, tokens));

const topColors = topEntries(tokens.colors, 5, 2).map(c => c.value + ' x' + c.count).join(', ');
const topSpacing = topEntries(tokens.spacings, 6, 3).map(c => c.value).join(', ');
log(`css ${(css.length / 1024).toFixed(0)}KB | colors ${Object.keys(tokens.colors).length} | fonts ${Object.keys(tokens.fontFamilies).length} | sizes ${Object.keys(tokens.fontSizes).length} | spacing ${Object.keys(tokens.spacings).length} | vars ${Object.keys(tokens.variables).length}`);
log('top colors:', topColors || '—');
log('spacing scale:', topSpacing || '—');
log('report ->', join(outDir, 'tokens.html'));
emit({ kind: 'tokens-done', host, pages: candidates.length, colors: Object.keys(tokens.colors).length, variables: Object.keys(tokens.variables).length, path: join(outDir, 'tokens.html') });
