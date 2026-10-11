import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(process.argv[2], { waitUntil: 'load', timeout: 40000 }).catch(()=>{});
await p.waitForTimeout(6000);
const r = await p.evaluate(() => ({ title: document.title, h1: document.querySelector('h1')?.textContent?.trim().slice(0, 60) ?? null, path: location.pathname }));
console.log(JSON.stringify(r));
await b.close();
