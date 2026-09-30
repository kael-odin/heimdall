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
import { getEnv } from './env.mjs';
const ENV = getEnv();

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

// 克隆页静态服务由 engine-server 常驻提供（/static/...），无需临时 serve
const CLONE_URL = `http://127.0.0.1:8900/static/${host}/pages/${NAME}/clone/index.html`;

const STAGES = [
  ['capture', 'crawler/capture.mjs', [URL_, DIR]],
  ['build', 'crawler/build_clone.mjs', [DIR]],
  ['shot', 'crawler/shot_clone.mjs', [CLONE_URL, join(DIR, 'shot-clone.png')]],
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

  // AI 校准：fixup 内部按"可修性信号"（静态差异占比）自判是否值得跑（动画噪声页自动豁免）
  emit({ kind: 'forge-stage', stage: 'fixup', status: 'running' });
  log(`\n==== [fixup] ====`);
  await run('differ/fixup.mjs', [DIR, '2']);
  emit({ kind: 'forge-stage', stage: 'fixup', status: 'done' });

  emit({ kind: 'forge-stage', stage: 'harvest', status: 'running' });
  log(`\n==== [harvest] ====`);
  await run('harvest/harvest.mjs', [DIR]);
  emit({ kind: 'forge-stage', stage: 'harvest', status: 'done' });

  // 跨页情报汇总（每次 forge 后刷新 host 级 xlsx）
  await run('harvest/xlsx.mjs', [host]);
  log(`\nPIPELINE DONE -> ${DIR}`);
} catch (e) {
  failed = String(e);
  emit({ kind: 'forge-error', error: failed });
}
process.exit(failed ? 1 : 0);
