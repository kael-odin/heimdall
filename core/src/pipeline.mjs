/**
 * pipeline — 一条命令跑完整还原流水线
 *
 *   node src/pipeline.mjs <url> <pageName>
 *   例: node src/pipeline.mjs https://apify.com/pricing pricing
 *
 * 步骤: capture → build_clone → serve → shot_clone → diff
 * 产物: workspace/<host>/pages/<pageName>/
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL_ = process.argv[2];
const NAME = process.argv[3] ?? 'page';
if (!URL_) { console.error('usage: node src/pipeline.mjs <url> <pageName>'); process.exit(1); }

const host = new URL(URL_).hostname;
const DIR = join('workspace', host, 'pages', NAME);
mkdirSync(DIR, { recursive: true });

const run = (script, args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join('src', script), ...args], { stdio: 'inherit' });
  p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  p.on('error', reject);
});

const PORT = 8961;
const serve = spawn(process.execPath, [join('src', 'crawler', 'serve.mjs'), join(DIR, 'clone'), String(PORT)], { stdio: 'ignore', detached: true });

try {
  console.log(`\n==== [1/5] capture ${URL_} ====`);
  await run('crawler/capture.mjs', [URL_, DIR]);
  console.log(`\n==== [2/5] build clone ====`);
  await run('crawler/build_clone.mjs', [DIR]);
  console.log(`\n==== [3/5] wait serve ====`);
  await new Promise((res, rej) => {
    const t0 = Date.now();
    const ping = async () => {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) return res(); } catch {}
      if (Date.now() - t0 > 10_000) return rej(new Error('serve timeout'));
      setTimeout(ping, 300);
    };
    ping();
  });
  console.log(`\n==== [4/5] screenshot clone ====`);
  await run('crawler/shot_clone.mjs', [`http://127.0.0.1:${PORT}/index.html`, join(DIR, 'shot-clone.png')]);
  console.log(`\n==== [5/5] diff & score ====`);
  await run('differ/diff.mjs', [DIR]);
  console.log(`\nPIPELINE DONE -> ${DIR}`);
} finally {
  try { process.kill(-serve.pid); } catch { try { serve.kill(); } catch {} }
}
