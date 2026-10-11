import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('request', r => {
  if (/\.async\.js$/.test(r.url()) && r.url().includes('127.0.0.1')) {
    console.log('REQ', r.url().slice(0, 80));
    console.log('    referer =', JSON.stringify(r.headers()['referer'] ?? null), ' rtype =', r.resourceType());
  }
});
await p.goto(process.argv[2], { waitUntil: 'load', timeout: 40000 }).catch(()=>{});
await p.waitForTimeout(6000);
await b.close();
