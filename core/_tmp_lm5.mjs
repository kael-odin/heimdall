import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const seen = new Map();
p.on('request', r => { seen.set(r, r.headers()); });
p.on('response', r => {
  if (r.status() === 404 && /\.async\.js$/.test(r.url())) {
    const h = seen.get(r.request()) ?? {};
    console.log('404', r.url().split('/').pop().slice(0, 45), '| referer=', JSON.stringify(h.referer ?? null), '| sec-fetch-dest=', h['sec-fetch-dest'] ?? '-', '| method=', r.request().method());
  }
});
await p.goto(process.argv[2], { waitUntil: 'load', timeout: 40000 }).catch(()=>{});
await p.waitForTimeout(6000);
await b.close();
