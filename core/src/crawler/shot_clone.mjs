/** W0 克隆页截图 — 与 capture.mjs 同视口同冻结策略，保证 diff 公平 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8900/static/apify.com/pages/home/clone/index.html';
const OUT = process.argv[3] ?? join(WORKSPACE, 'apify.com', 'pages', 'home', 'shot-clone.png');

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
await page.goto(URL_, { waitUntil: 'networkidle', timeout: 30_000 });
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({ content: FREEZE_CSS });
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT });
await page.screenshot({ path: OUT.replace(/\.png$/, '.jpg'), type: 'jpeg', quality: 55 });
console.log('clone screenshot ->', OUT);
await browser.close();
