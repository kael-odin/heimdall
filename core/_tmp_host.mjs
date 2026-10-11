import { chromium, firefox } from 'playwright';
for (const [name, type] of [['chromium', chromium]]) {
  const b = await type.launch();
  const p = await b.newPage();
  const r = await p.goto('http://probe.localhost:8900/api/status', { timeout: 15000 }).catch(e => ({ status: () => 'ERR ' + String(e).slice(0, 60) }));
  console.log(name, '→', await r.status());
  await b.close();
}
