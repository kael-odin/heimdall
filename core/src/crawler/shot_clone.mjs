/**
 * shot_clone — 克隆页截图（与 capture.mjs 同视口同冻结策略，保证 diff 公平）
 *
 * URL 可以是 http(s)://（引擎 /static）或 file://（引擎未运行时 pipeline 的回退路径）。
 *
 * 用法: node src/crawler/shot_clone.mjs <cloneUrl> <outPng>
 */
import { chromium } from 'playwright';
import { requireArg } from '../args.mjs';

const URL_ = requireArg(process.argv[2], 'node src/crawler/shot_clone.mjs <cloneUrl> <outPng>', '克隆页 URL');
const OUT = requireArg(process.argv[3], 'node src/crawler/shot_clone.mjs <cloneUrl> <outPng>', '输出图片路径');

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// file:// 下没有网络活动，networkidle 立即达成；http 下用它等资源就绪
await page.goto(URL_, { waitUntil: 'networkidle', timeout: 30_000 });
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({ content: FREEZE_CSS });
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT });
await page.screenshot({ path: OUT.replace(/\.png$/, '.jpg'), type: 'jpeg', quality: 55 });
console.log('clone screenshot ->', OUT);
await browser.close();
