/**
 * pipeline — 一条命令跑完整还原流水线（事件化，供 engine-server 转发 SSE）
 *
 *   node src/pipeline.mjs <url> <pageName>
 *   例: node src/pipeline.mjs https://apify.com/pricing pricing
 *
 * 事件（@@EVENT@@ 行）:
 *   {kind:'forge-stage', stage, status:'running'|'done'}
 *   {kind:'forge-score', score}
 * 产物: workspace/<host>/pages/<pageName>/
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const URL_ = process.argv[2];
const NAME = process.argv[3] ?? 'page';
if (!URL_) { console.error('usage: node src/pipeline.mjs <url> <pageName>'); process.exit(1); }

const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
const log = (...a) => console.error(...a);

const host = new URL(URL_).hostname.replace(/^www\./, '');
const DIR = join('workspace', host, 'pages', NAME);
mkdirSync(DIR, { recursive: true });

const run = (script, args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join('src', script), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  p.on('error', reject);
});

const PORT = 8961;
const serve = spawn(process.execPath, [join('src', 'crawler', 'serve.mjs'), join(DIR, 'clone'), String(PORT)], { stdio: 'ignore', detached: true });

const STAGES = [
  ['capture', 'crawler/capture.mjs', [URL_, DIR]],
  ['build', 'crawler/build_clone.mjs', [DIR]],
  ['shot', 'crawler/shot_clone.mjs', [`http://127.0.0.1:${PORT}/index.html`, join(DIR, 'shot-clone.png')]],
];

let failed = null;
try {
  for (const [stage, script, args] of STAGES) {
    emit({ kind: 'forge-stage', stage, status: 'running' });
    log(`\n==== [${stage}] ====`);
    await run(script, args);
    emit({ kind: 'forge-stage', stage, status: 'done' });
  }
  emit({ kind: 'forge-stage', stage: 'diff', status: 'running' });
  log(`\n==== [diff] ====`);
  await run('differ/diff.mjs', [DIR]);
  const score = JSON.parse(readFileSync(join(DIR, 'score.json'), 'utf8'));
  emit({ kind: 'forge-score', score });
  emit({ kind: 'forge-stage', stage: 'diff', status: 'done' });

  emit({ kind: 'forge-stage', stage: 'harvest', status: 'running' });
  log(`\n==== [harvest] ====`);
  await run('harvest/harvest.mjs', [DIR]);
  emit({ kind: 'forge-stage', stage: 'harvest', status: 'done' });
  log(`\nPIPELINE DONE -> ${DIR}`);
} catch (e) {
  failed = String(e);
  emit({ kind: 'forge-error', error: failed });
} finally {
  try { process.kill(-serve.pid); } catch { try { serve.kill(); } catch {} }
}
process.exit(failed ? 1 : 0);
