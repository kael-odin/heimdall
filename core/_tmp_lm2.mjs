import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const reqs = [];
p.on('response', r => reqs.push(r.status() + ' ' + r.request().resourceType() + ' ' + r.url().slice(0, 120)));
await p.goto(process.argv[2], { waitUntil: 'load', timeout: 40000 }).catch(e => reqs.push('goto-fail ' + String(e).slice(0, 100)));
await p.waitForTimeout(3000);
console.log(reqs.slice(0, 25).join('\n'));
await b.close();
