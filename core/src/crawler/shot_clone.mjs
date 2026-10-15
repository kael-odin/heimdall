/**
 * shot_clone — 克隆页截图（与 capture.mjs 同视口同冻结策略，保证 diff 公平）
 *
 * 本地 file:// 克隆会经当前 workspace 的临时回环 HTTP 服务加载资产。
 *
 * 用法: node src/crawler/shot_clone.mjs <cloneUrl> <outPng>
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { requireArg } from '../args.mjs';
import { freezeCss } from '../freeze.mjs';
import { startClonePreviewServer } from '../clone-preview-server.mjs';

const URL_ = requireArg(process.argv[2], 'node src/crawler/shot_clone.mjs <cloneUrl> <outPng>', '克隆页 URL');
const OUT = requireArg(process.argv[3], 'node src/crawler/shot_clone.mjs <cloneUrl> <outPng>', '输出图片路径');

// 与原站截图同条件：镜像侧也要冻结，否则两边截在动画的不同帧上，比出来的是时序差
const FREEZE_CSS = freezeCss();

const local = new URL(URL_).protocol === 'file:' ? await startClonePreviewServer() : null;
let browser;
try {
  const target = local ? local.urlFor(fileURLToPath(URL_)) : URL_;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let documentResponse = null;
  page.on('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentResponse = response;
  });
  await page.goto(target, { waitUntil: 'networkidle', timeout: 30_000 });
  const mime = documentResponse?.headers()['content-type'] ?? '';
  if (!documentResponse?.ok() || !/^text\/html(?:;|$)/i.test(mime)
      || (local && !page.url().startsWith(new URL('.', target).href))) {
    throw new Error(`clone document is not local HTML (HTTP ${documentResponse?.status() ?? 'no response'}, ${mime || 'no content-type'}): ${page.url()}`);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT });
  await page.screenshot({ path: OUT.replace(/\.png$/, '.jpg'), type: 'jpeg', quality: 55 });
  console.log('clone screenshot ->', OUT);
} finally {
  await browser?.close();
  await local?.close();
}
