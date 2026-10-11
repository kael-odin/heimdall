import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(process.argv[2], { waitUntil: 'load', timeout: 40000 }).catch(()=>{});
await p.waitForTimeout(6000);
await p.screenshot({ path: process.argv[3] });
console.log('shot ->', process.argv[3]);
await b.close();
