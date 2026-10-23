/**
 * 多视口快照不能把"截图冻结样式"烤进 375/768 的 CSSOM
 *
 * 已发生的真实缺陷：multi-snapshot 先 `addStyleTag(freezeCss({consent:true}))`
 * 再读 document.styleSheets（桌面那份是 capture.mjs 先读后注入，顺序相反）。
 * 注入的样式照样出现在 document.styleSheets 里，于是 `animation-duration:0s !important`
 * 与「隐藏所有 cookie/consent 元素」一起落进了 cssom-375.css / cssom-768.css ——
 * 移动端克隆把同意弹窗藏掉、动画停住，桌面端不藏，三个视口口径不一致，
 * 而这些规则本来只该用于截图对比。
 *
 * 断言方向：产物里**不能**出现冻结规则；站点自己的 cookie 选择器**必须**还在；
 * 两个视口的 CSSOM 口径一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { snapPage } from '../src/crawler/multi-snapshot.mjs';
import { FREEZE_MARK } from '../src/freeze.mjs';

const SITE_CSS = 'main{background:#123}.cookie-banner{position:fixed;bottom:0;height:60px}';
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/site.css"></head>'
  + '<body><main style="height:600px">hi</main><div class="cookie-banner">cookies</div></body></html>';

/** 冻结样式有没有进产物：CSSOM 里任何一条痕迹都算 */
function freezeEvidence(text) {
  const hits = [];
  if (text.includes(FREEZE_MARK)) hits.push('mark');
  if (/animation-duration\s*:\s*0s/.test(text)) hits.push('animation-duration:0s');
  if (/caret-color\s*:\s*transparent/.test(text)) hits.push('caret-color:transparent');
  // 冻结里的隐藏规则按选择器认：`[class*="cookie" i]` / `[id*="consent" i]` …
  if (/\[(?:class|id)\*="(?:cookie|consent|gdpr)"\s+i\]/.test(text)) hits.push('consent-hide');
  return hits;
}

test('375/768 的 CSSOM 不含注入的冻结样式，且两个视口一致', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-snap-freeze-'));
  const pageDir = join(root, 'pages', 'home');
  mkdirSync(pageDir, { recursive: true });
  const site = createServer((req, res) => {
    if (req.url === '/site.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(SITE_CSS); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE);
  });
  let browser;
  try {
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    writeFileSync(join(pageDir, 'manifest.json'), JSON.stringify({ target: `http://127.0.0.1:${site.address().port}/` }));
    browser = await chromium.launch();
    await snapPage(browser, 'fixture.test', 'home', [375, 768], pageDir);

    const css = { 375: readFileSync(join(pageDir, 'cssom-375.css'), 'utf8'), 768: readFileSync(join(pageDir, 'cssom-768.css'), 'utf8') };
    const dom = { 375: readFileSync(join(pageDir, 'dom-375.html'), 'utf8'), 768: readFileSync(join(pageDir, 'dom-768.html'), 'utf8') };

    for (const width of [375, 768]) {
      assert.deepEqual(freezeEvidence(css[width]), [], `cssom-${width}.css 不应含冻结样式`);
      assert.match(css[width], /\.cookie-banner\s*\{/, `cssom-${width}.css 必须保留站点自己的规则`);
      assert.deepEqual(freezeEvidence(dom[width]), [], `dom-${width}.html 不应含冻结样式`);
    }
    // 口径一致：同一份站点样式在两个视口下序列化结果相同（夹具没有宽度相关规则）
    assert.equal(css[375], css[768], '375 与 768 的 CSSOM 必须同口径');
  } finally {
    await browser?.close();
    if (site.listening) await new Promise(resolve => site.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
