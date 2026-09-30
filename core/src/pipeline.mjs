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

// 轻量 .env 读取（fixup 门控阈值等）
const ENV = (() => {
  const e = {};
  try {
    for (const line of readFileSync(join('src', '..', '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) e[m[1]] = m[2];
    }
  } catch {}
  return e;
})();

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

  // AI 校准只对有修复空间的页面跑（pixel>=97% 的高分页跳过，省 3-5 分钟）
  const preScore = JSON.parse(readFileSync(join(DIR, 'score.json'), 'utf8'));
  // 门控阈值可配置（.env FIXUP_PIXEL_GATE）；注意 pixel 受动画噪声影响，"可修性判断"待后续精细化
  const gate = Number(process.env.FIXUP_PIXEL_GATE ?? ENV.FIXUP_PIXEL_GATE ?? 0.97);
  emit({ kind: 'forge-stage', stage: 'fixup', status: preScore.pixel < 0.97 ? 'running' : 'skipped' });
  if (preScore.pixel < gate) {
    log(`
==== [fixup] (pixel ${(preScore.pixel * 100).toFixed(1)}% has room) ====`);
    await run('differ/fixup.mjs', [DIR, '2', String(PORT)]);
    emit({ kind: 'forge-stage', stage: 'fixup', status: 'done' });
  } else {
    log(`
==== [fixup] skipped (pixel ${(preScore.pixel * 100).toFixed(1)}% already high) ====`);
  }

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
